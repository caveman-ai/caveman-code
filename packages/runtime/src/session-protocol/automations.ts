// automation.*: automation files (.caveman/automations/*.yaml, packages/automations/README.md) beside the runtime's
// scheduled tasks (ScheduledTaskService, ported from T3), on one Session Protocol API.
//
// Files: listed with their steps, problems, triggers and runs; checked live (unsaved editor text included);
// explained; created from a template or from text; read and written only inside the automation and agent
// folders; run by hand through the AutomationRunner; turned on and off in the runtime's state, never in the
// file. New automations are always files (BUILD D9).
//
// Scheduled tasks saved in the app before files (`source: "app"`) keep working and are listed beside them.
// Each run is a new workspace in the automation's project (the projector adopts it, daemon.ts). Triggers:
// an interval, a daily time, a webhook (the runtime's /api/hooks route, HMAC-checked when it has a secret),
// and GitHub: a comment of the signed-in GitHub user's mentioning @caveman, found by polling the
// repository's comments each minute and handed to the automation as a webhook delivery, so its prompt
// template, delivery log and rate limits apply unchanged.
import * as fs from "node:fs";

import {
  explain,
  renderExplain,
  scheduleWords,
  subjectKindOf,
  templateSummary,
  templates,
  triggerKinds,
  hostOf,
  triggerWords,
  type EnvSnapshot,
  type LoadedAutomation,
  type ProjectCheck,
  type Scope,
} from "@caveman-app/automations";
import {
  isWebhookDedupeTemplate,
  ProjectId,
  ScheduledTaskId,
  ScheduledTaskSchedule as ScheduledTaskScheduleSchema,
  type ModelSelection,
  type RuntimeMode,
  type ScheduledTask,
  type ScheduledTaskUpsertSchedule,
  type ScheduledTaskWebhookFilter,
} from "@caveman-app/protocol";
import type { AccessMode, Automation, AutomationRunSummary, EngineId, Params } from "@caveman-app/session-protocol/protocol";
import * as GitHubCredentials from "@caveman-app/source-control-github/server/GitHubCredentials";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import { makeEnvReader } from "../automations/env.ts";
import { draftProjectRef, splitProjectRef, type Worktree } from "../automations/drafts.ts";
import { AutomationFilesError, AutomationProjects, agentsUsed, blockingErrors, createFromTemplate, createFromText, editablePath, type BranchView } from "../automations/files.ts";
import { AutomationRunner } from "../automations/services.ts";
import { AutomationTriggers, fileAutomationId, parseFileAutomationId, ulid, type Candidate, type DeliveryRecord } from "../automations/triggers.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import { CLOUD_SCHEDULE_ID, CloudSchedules, type CloudSchedule, type CloudScheduleError } from "./cloudSchedules.ts";
import type { Handler } from "./handlers.ts";
import { ProtocolError } from "./handlers.ts";
import { engineIdForInstance } from "./projector.ts";
import type { SessionStore } from "./store.ts";

type AutomationMethod =
  | "automation.list"
  | "automation.save"
  | "automation.set_enabled"
  | "automation.delete"
  | "automation.run"
  | "automation.rotate_url"
  | "automation.set_webhook_rules"
  | "automation.deliveries"
  | "automation.check"
  | "automation.explain"
  | "automation.templates"
  | "automation.create"
  | "automation.file_read"
  | "automation.file_write"
  | "automation.allow";

const DAY_MS = 86_400_000;
const RUNNING = new Set(["queued", "running", "waiting"]);

/** One cell per day for the last 30 days, oldest first: failed when the day's last finished run failed. */
export function last30(runs: ReadonlyArray<Pick<AutomationRunSummary, "status" | "started_at" | "ended_at">>, now: number): Array<"worked" | "failed" | "none"> {
  const today = Math.floor(now / DAY_MS);
  const cells: Array<"worked" | "failed" | "none"> = Array.from({ length: 30 }, () => "none");
  const latest: Array<string | undefined> = [];
  for (const run of runs) {
    if (run.status !== "succeeded" && run.status !== "failed") continue;
    const day = today - Math.floor(Date.parse(run.ended_at ?? run.started_at) / DAY_MS);
    if (day < 0 || day >= 30) continue;
    const at = run.ended_at ?? run.started_at;
    if (latest[29 - day] !== undefined && latest[29 - day]! > at) continue;
    latest[29 - day] = at;
    cells[29 - day] = run.status === "succeeded" ? "worked" : "failed";
  }
  return cells;
}

/** The automation's diagnostics: its file's, and those of the agent files it uses. */
const diagnosticsOf = (check: ProjectCheck, automation: LoadedAutomation) => {
  const used = new Set(agentsUsed(automation.file));
  const paths = new Set([automation.path, ...check.agents.filter((a) => used.has(a.name) && a.path !== undefined).map((a) => a.path!)]);
  return check.diagnostics.filter((d) => paths.has(d.path));
};

const filesProblem = (error: AutomationFilesError) => new ProtocolError({ reason: error.reason, message: error.message });

/** A file automation's delivery on the wire: what happened as data (B5), and `outcome` still one readable sentence. */
export function deliveryOf(d: DeliveryRecord) {
  const about = d.subjectTitle ? `${d.subject} (${d.subjectTitle})` : d.subject;
  const by = d.by === undefined ? "" : d.by.startsWith("labelled") ? `, ${d.by}` : `, by ${d.by}`;
  const outcome =
    d.outcome === "started"
      ? `Started ${d.runId ?? "a run"} for ${about}${by}.`
      : `${d.outcome === "skipped" ? "Skipped" : "Refused"} ${about}${by}: ${d.message ?? d.reason ?? "no reason was given."}`;
  return {
    id: d.id,
    received_at: d.at,
    outcome,
    error: d.outcome === "started" ? null : (d.message ?? null),
    status: d.outcome,
    ...(d.reason ? { reason: d.reason } : {}),
    ...(d.runId ? { run_id: d.runId } : {}),
    event: d.event ?? d.kind,
    subject: d.subject,
    ...(d.subjectTitle ? { subject_title: d.subjectTitle } : {}),
  };
}

const ME_FILE = /^\.caveman\/local\/automations\/([a-z][a-z0-9_-]{0,39})\.yaml$/;

/** A GitHub trigger: which repository, and the newest comment already seen. */
interface GitHubSource {
  readonly repo: string;
  readonly since: string;
}
const SOURCES_KEY = "automation_github_sources";
/** The automations saved without a model: each run resolves the new-chat default. */
const FOLLOWS_DEFAULT_KEY = "automation_follows_default";
/** What a GitHub trigger appends to the person's prompt; the poller fills it from the comment. */
/** The placeholders in GITHUB_MENTION_TEMPLATE that carry the signed-in user's own words. */
export const GITHUB_MENTION_TRUSTED_PATHS = ["body.comment.user.login", "body.comment.body"] as const;
export const GITHUB_MENTION_TEMPLATE = "\n\n{{body.comment.user.login}} on {{body.issue.html_url}} ({{body.issue.title}}):\n{{body.comment.body}}";
const MENTION = /(^|[^\w@])@caveman\b/i;

export interface GitHubComment {
  readonly id: number;
  readonly body: string;
  readonly created_at: string;
  readonly user: { readonly login: string } | null;
  readonly issue_url: string;
  readonly html_url: string;
}

/** Comments that start a run: newer than `since`, by `me`, mentioning @caveman; oldest first. */
export function mentionsToRun(comments: ReadonlyArray<GitHubComment>, me: string, since: string): GitHubComment[] {
  return comments
    .filter((c) => c.created_at > since && c.user?.login.toLowerCase() === me.toLowerCase() && MENTION.test(c.body))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

type WireFilter = NonNullable<Params<"automation.set_webhook_rules">["filters"]>[number];
type WireDedupe = NonNullable<Params<"automation.set_webhook_rules">["dedupe"]>;
type StoredDedupe = NonNullable<Extract<ScheduledTask["schedule"], { type: "webhook" }>["dedupe"]>;

const T3_FILTER_OP = { equals: "equals", not_equals: "notEquals", starts_with: "startsWith", in: "in", exists: "exists" } as const;
const WIRE_FILTER_OP = { equals: "equals", notEquals: "not_equals", startsWith: "starts_with", in: "in", exists: "exists" } as const;

/** A webhook filter as ScheduledTaskService stores it (upstream camelCase ops), from the wire's. */
export function storedFilter(filter: WireFilter): ScheduledTaskWebhookFilter {
  if (filter.op === "exists") return { path: filter.path, op: "exists" };
  if (filter.op === "in") return { path: filter.path, op: "in", value: [...filter.value] };
  return { path: filter.path, op: T3_FILTER_OP[filter.op], value: filter.value };
}

/** A stored webhook filter on the wire. */
export function wireFilter(filter: ScheduledTaskWebhookFilter): WireFilter {
  if (filter.op === "exists") return { path: filter.path, op: "exists" };
  if (filter.op === "in") return { path: filter.path, op: "in", value: [...filter.value] };
  return { path: filter.path, op: WIRE_FILTER_OP[filter.op], value: filter.value };
}

export const storedDedupe = (dedupe: WireDedupe): StoredDedupe => ({
  ...(dedupe.replay_key === undefined ? {} : { replayKey: dedupe.replay_key }),
  ...(dedupe.coalesce_key === undefined ? {} : { coalesceKey: dedupe.coalesce_key }),
  ...(dedupe.coalesce_window_seconds === undefined ? {} : { coalesceWindowSeconds: dedupe.coalesce_window_seconds }),
});

const wireDedupe = (dedupe: StoredDedupe): WireDedupe => ({
  ...(dedupe.replayKey === undefined ? {} : { replay_key: dedupe.replayKey }),
  ...(dedupe.coalesceKey === undefined ? {} : { coalesce_key: dedupe.coalesceKey }),
  ...(dedupe.coalesceWindowSeconds === undefined ? {} : { coalesce_window_seconds: dedupe.coalesceWindowSeconds }),
});

/** Why a dedupe's key templates can't be stored, in words; undefined when both can. */
export function dedupeProblem(dedupe: WireDedupe | undefined): string | undefined {
  for (const [name, key] of [["replay_key", dedupe?.replay_key], ["coalesce_key", dedupe?.coalesce_key]] as const) {
    if (key !== undefined && !isWebhookDedupeTemplate(key.trim())) {
      return `${name} must use request placeholders such as {{headers.x-github-delivery}} or {{body.issue.number}}, and nothing in braces besides them.`;
    }
  }
  return undefined;
}

type WireEnds = { readonly start_at?: string; readonly until?: string; readonly max_runs?: number };
type StoredEnds = { readonly startAt?: string | undefined; readonly until?: string | undefined; readonly maxRuns?: number | undefined };

/** A repeat's start, end and run count, wire to stored. */
const storedEnds = (t: WireEnds) => ({
  ...(t.start_at === undefined ? {} : { startAt: t.start_at }),
  ...(t.until === undefined ? {} : { until: t.until }),
  ...(t.max_runs === undefined ? {} : { maxRuns: t.max_runs }),
});

/** A repeat's start, end and run count, stored to wire. */
const wireEnds = (s: StoredEnds) => ({
  ...(s.startAt === undefined ? {} : { start_at: s.startAt }),
  ...(s.until === undefined ? {} : { until: s.until }),
  ...(s.maxRuns === undefined ? {} : { max_runs: s.maxRuns }),
});

/** The T3 schedule an automation trigger is stored as. A GitHub trigger is a webhook only the runtime calls. */
export function scheduleFor(trigger: Params<"automation.save">["trigger"]): ScheduledTaskUpsertSchedule {
  switch (trigger.type) {
    case "interval":
      return { type: "interval", everyMs: trigger.every_minutes * 60_000, ...storedEnds(trigger) };
    case "daily":
      return {
        type: "fixed_time",
        timeOfDay: trigger.time,
        ...(trigger.weekdays === undefined ? {} : { weekdays: [...trigger.weekdays] }),
        ...(trigger.every_days === undefined ? {} : { everyDays: trigger.every_days }),
        ...(trigger.every_weeks === undefined ? {} : { everyWeeks: trigger.every_weeks }),
        ...(trigger.timezone === undefined ? {} : { timeZone: trigger.timezone }),
        ...storedEnds(trigger),
      };
    case "monthly":
      return {
        type: "monthly",
        timeOfDay: trigger.time,
        days: [...trigger.days],
        ...(trigger.timezone === undefined ? {} : { timeZone: trigger.timezone }),
        ...storedEnds(trigger),
      };
    case "cron":
      return { type: "cron", expression: trigger.expression, timeZone: trigger.timezone, ...storedEnds(trigger) };
    case "once":
      return { type: "once", runAt: trigger.run_at };
    case "webhook": {
      // keep_secret: a signature with no secret, so ScheduledTaskService keeps the stored one (or refuses when there is none).
      const header = { header: trigger.signature_header ?? "x-hub-signature-256", encoding: "hex", prefix: "sha256=" } as const;
      return {
        type: "webhook",
        signature: trigger.secret !== undefined ? { ...header, secret: trigger.secret } : trigger.keep_secret === true ? header : null,
        // Absent keeps what is stored (ScheduledTaskService); [] and {} clear them.
        ...(trigger.filters === undefined ? {} : { filters: trigger.filters.map(storedFilter) }),
        ...(trigger.dedupe === undefined ? {} : { dedupe: storedDedupe(trigger.dedupe) }),
      };
    }
    case "github_mention":
      return { type: "webhook", signature: null };
  }
}

/** A schedule that runs at times (every kind but a webhook), as the wire's trigger says it. */
function timedTrigger(s: Exclude<ScheduledTask["schedule"], { type: "webhook" }>): typeof Automation.Type["trigger"] {
  switch (s.type) {
    case "interval":
      return { type: "interval", every_minutes: Math.max(1, Math.round(s.everyMs / 60_000)), ...wireEnds(s) };
    case "fixed_time":
      return {
        type: "daily",
        time: s.timeOfDay,
        ...(s.weekdays === undefined ? {} : { weekdays: [...s.weekdays] }),
        ...(s.everyDays === undefined ? {} : { every_days: s.everyDays }),
        ...(s.everyWeeks === undefined ? {} : { every_weeks: s.everyWeeks }),
        ...(s.timeZone === undefined ? {} : { timezone: s.timeZone }),
        ...wireEnds(s),
      };
    case "monthly":
      return { type: "monthly", time: s.timeOfDay, days: [...s.days], ...(s.timeZone === undefined ? {} : { timezone: s.timeZone }), ...wireEnds(s) };
    case "cron":
      return { type: "cron", expression: s.expression, timezone: s.timeZone, ...wireEnds(s) };
    case "once":
      return { type: "once", run_at: s.runAt };
  }
}

/** A stored task on the wire. */
export function automationOf(task: ScheduledTask, github: GitHubSource | undefined, followsDefault = false, chat?: string): typeof Automation.Type {
  const s = task.schedule;
  const trigger: typeof Automation.Type["trigger"] =
    github !== undefined
      ? { type: "github_mention", repo: github.repo }
      : s.type !== "webhook"
        ? timedTrigger(s)
        : {
              type: "webhook",
              path: task.webhook?.path ?? "",
              url: task.webhook?.url ?? null,
              signed: task.webhook?.hasSecret ?? false,
              ...(s.filters && s.filters.length > 0 ? { filters: s.filters.map(wireFilter) } : {}),
              ...(s.dedupe && (s.dedupe.replayKey !== undefined || s.dedupe.coalesceKey !== undefined) ? { dedupe: wireDedupe(s.dedupe) } : {}),
            };
  return {
    id: task.id,
    title: task.title,
    prompt: github === undefined ? task.prompt : task.prompt.replace(GITHUB_MENTION_TEMPLATE, ""),
    enabled: task.enabled,
    trigger,
    project_id: task.projectId,
    engine: engineIdForInstance(task.modelSelection.instanceId) as typeof Automation.Type["engine"],
    model: task.modelSelection.model,
    ...(followsDefault ? { follows_default: true } : {}),
    next_run_at: task.nextRunAt,
    last_run_at: task.lastRunAt,
    last_status: task.lastRunStatus,
    last_error: task.lastRunError,
    run_count: task.runCount,
    source: "app",
    ...(chat === undefined ? {} : { workspace_id: chat }),
  };
}

const decodeCloudSchedule = Schema.decodeUnknownOption(ScheduledTaskScheduleSchema);

/** A Cloud schedule on the wire: it fires in Cloud, and an agent's waits for the person's Allow. */
export function cloudAutomationOf(schedule: CloudSchedule): typeof Automation.Type | undefined {
  const decoded = decodeCloudSchedule(schedule.schedule);
  if (decoded._tag === "None" || decoded.value.type === "webhook") return undefined;
  // Its Cloud computer keeps UTC: a time of day there is a UTC one.
  const timed = timedTrigger(decoded.value);
  const trigger = timed.type === "daily" && timed.timezone === undefined ? { ...timed, timezone: "UTC" } : timed;
  const failedToStart = schedule.state === "failed";
  return {
    id: schedule.id,
    title: schedule.title,
    prompt: schedule.prompt,
    enabled: schedule.enabled,
    trigger,
    project_id: schedule.projectId,
    engine: schedule.engine as typeof Automation.Type["engine"],
    model: "",
    next_run_at: schedule.nextRunAt,
    last_run_at: schedule.lastRunAt,
    last_status: failedToStart && schedule.lastStatus === "never" ? "failed" : schedule.lastStatus,
    last_error: failedToStart && schedule.lastError === null ? "It could not start on a Cloud computer. Allow it again to retry." : schedule.lastError,
    run_count: schedule.runCount,
    source: "app",
    host: "cloud",
    workspace_id: schedule.leadWorkspaceId,
    ...(schedule.state === "awaiting_approval" ? { awaiting_approval: true } : {}),
  };
}

/** The hook id and secret token in a webhook task's path (`/api/hooks/<id>/<token>`). */
const hookOf = (task: ScheduledTask) => {
  const [id, token] = (task.webhook?.path ?? "").slice(`${ScheduledTaskService.WEBHOOK_ROUTE_PREFIX}/`.length).split("/");
  return id && token ? { id: decodeURIComponent(id), token: decodeURIComponent(token) } : undefined;
};

export const makeAutomationHandlers = (deps: {
  readonly store: SessionStore["Service"];
  /**
 * upstream model selection and runtime mode for an engine, model and access, as workspace.create picks them; without a
   * model, the new-chat default in the project.
   */
  readonly launch: (
    engine: string,
    model: string | undefined,
    access: AccessMode | undefined,
    projectId: string,
  ) => Effect.Effect<{ readonly modelSelection: ModelSelection; readonly runtimeMode: RuntimeMode }, ProtocolError>;
}) =>
  Effect.gen(function* () {
    const tasks = yield* Effect.serviceOption(ScheduledTaskService.ScheduledTaskService);
    const github = yield* Effect.serviceOption(GitHubCredentials.GitHubCredentials);
    const fail = (reason: string, message: string) => new ProtocolError({ reason, message });
    const need: Effect.Effect<ScheduledTaskService.ScheduledTaskService["Service"], ProtocolError> = Option.isNone(tasks)
      ? Effect.fail(fail("unsupported", "this runtime has no automations"))
      : Effect.succeed(tasks.value);
    const taskError = (error: { readonly message: string }) => fail(/not found|no longer exists/i.test(error.message) ? "not_found" : "invalid_params", error.message);

    const sources = deps.store.kvGet(SOURCES_KEY).pipe(
      Effect.map((raw) => (raw ? (JSON.parse(raw) as Record<string, GitHubSource>) : {})),
      Effect.orElseSucceed((): Record<string, GitHubSource> => ({})),
    );
    const putSources = (next: Record<string, GitHubSource>) => deps.store.kvSet(SOURCES_KEY, JSON.stringify(next)).pipe(Effect.orDie);
    // Held by every change to the sources, and by the GitHub check while it reads the tasks with their sources and
    // while it writes back, never while it talks to GitHub: what a switch, save or delete changes in between stands.
    const sourcesLock = yield* Semaphore.make(1);
    const sameSource = (a: GitHubSource | undefined, b: GitHubSource | undefined) => a?.repo === b?.repo && a?.since === b?.since;
    const followsDefault = deps.store.kvGet(FOLLOWS_DEFAULT_KEY).pipe(
      Effect.map((raw) => new Set<string>(raw ? (JSON.parse(raw) as string[]) : [])),
      Effect.orElseSucceed(() => new Set<string>()),
    );
    const setFollowsDefault = (id: string, follows: boolean) =>
      followsDefault.pipe(
        Effect.flatMap((all) => {
          if (all.has(id) === follows) return Effect.void;
          if (follows) all.add(id);
          else all.delete(id);
          return deps.store.kvSet(FOLLOWS_DEFAULT_KEY, JSON.stringify([...all])).pipe(Effect.orDie);
        }),
      );
    // An agent's wake-up names the chat it posts in, so the page can open it.
    const chatOf = (task: ScheduledTask) =>
      task.threadId === null ? Effect.succeed(undefined) : deps.store.getByThread(task.threadId).pipe(Effect.map((record) => record?.workspace.id));
    const wire = (task: ScheduledTask) =>
      Effect.all([sources, followsDefault, chatOf(task)]).pipe(Effect.map(([all, follows, chat]) => automationOf(task, all[task.id], follows.has(task.id), chat)));

    // Schedules an agent set to run on Cloud (cloudSchedules.ts), listed and changed here beside the rest.
    const cloudOpt = yield* Effect.serviceOption(CloudSchedules);
    const isCloud = (id: string) => id.startsWith(CLOUD_SCHEDULE_ID);
    const needCloud: Effect.Effect<CloudSchedules["Service"], ProtocolError> = Option.isNone(cloudOpt) ? Effect.fail(fail("unsupported", "this runtime has no Cloud schedules")) : Effect.succeed(cloudOpt.value);
    const cloudError = (error: CloudScheduleError) => fail(error.reason === "not_found" ? "not_found" : error.reason === "invalid_request" ? "invalid_params" : "invalid_state", error.message);
    const cloudWire = (schedule: CloudSchedule) =>
      Effect.suspend(() => {
        const wired = cloudAutomationOf(schedule);
        return wired === undefined ? Effect.fail(fail("invalid_state", `${schedule.title} has a schedule this build cannot show.`)) : Effect.succeed(wired);
      });
    // A run of one that follows the default starts on that default as it is when it runs; a failure keeps the saved one.
    if (Option.isSome(tasks)) {
      yield* tasks.value.setRunModel((task) =>
        followsDefault.pipe(
          Effect.flatMap((follows) =>
            follows.has(task.id)
              ? deps.launch(engineIdForInstance(task.modelSelection.instanceId), undefined, undefined, task.projectId).pipe(
                  Effect.map(({ modelSelection }) => modelSelection),
                  Effect.orElseSucceed(() => undefined),
                )
              : Effect.succeed(undefined),
          ),
        ),
      );
    }
    const listAll = need.pipe(Effect.flatMap((service) => service.list().pipe(Effect.mapError(taskError))));
    const one = (id: string) =>
      listAll.pipe(
        Effect.flatMap(({ tasks: all }) => {
          const task = all.find((t) => t.id === id);
          return task === undefined ? Effect.fail(fail("not_found", `no automation ${id}`)) : Effect.succeed(task);
        }),
      );
    /** A GitHub trigger turned on hears only comments made from now on, as a new one does. */
    const hearFromNow = (taskId: string) =>
      sources.pipe(
        Effect.flatMap((all) => {
          const source = all[taskId];
          return source === undefined ? Effect.void : putSources({ ...all, [taskId]: { ...source, since: new Date().toISOString() } });
        }),
      );

    // GitHub: each trigger's repository comments since the newest seen, the signed-in user's
    // @caveman mentions handed to its task as a webhook delivery.
    const pollGitHub = Effect.gen(function* () {
      if (Option.isNone(tasks) || Option.isNone(github)) return;
      if (Object.keys(yield* sources).length === 0) return;
      const token = yield* github.value.get("github.com").pipe(Effect.map((c) => Redacted.value(c.token)), Effect.option);
      if (Option.isNone(token)) return;
      const api = (url: string) =>
        Effect.tryPromise(() =>
          fetch(url.startsWith("http") ? url : `https://api.github.com${url}`, {
            headers: { authorization: `Bearer ${token.value}`, accept: "application/vnd.github+json", "user-agent": "caveman-code" },
          }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`GitHub ${r.status} for ${url}`)))),
        );
      const me = ((yield* api("/user")) as { login: string }).login;
      // A task turned on before this is read with the `since` it was turned on at.
      const [{ tasks: current }, all] = yield* sourcesLock.withPermits(1)(
        Effect.all([tasks.value.list().pipe(Effect.orElseSucceed(() => ({ tasks: [] as ScheduledTask[] }))), sources]),
      );
      const checkedAt = new Date().toISOString();
      /** Each source's new state; undefined: its task is gone. */
      const seen = new Map<string, GitHubSource | undefined>();
      for (const [taskId, source] of Object.entries(all)) {
        const task = current.find((t) => t.id === taskId);
        if (task === undefined) {
          seen.set(taskId, undefined);
          continue;
        }
        const hook = hookOf(task);
        // Off, it hears nothing: what was said meanwhile never starts a run once it is back on.
        if (!task.enabled || hook === undefined) {
          seen.set(taskId, { ...source, since: checkedAt });
          continue;
        }
        const comments = (yield* api(`/repos/${source.repo}/issues/comments?since=${encodeURIComponent(source.since)}&per_page=100`).pipe(
          Effect.orElseSucceed(() => []),
        )) as GitHubComment[];
        for (const comment of mentionsToRun(comments, me, source.since)) {
          const issue = yield* api(comment.issue_url).pipe(Effect.orElseSucceed(() => ({ html_url: comment.html_url, title: "" })));
          const bodyText = JSON.stringify({ comment, issue, repository: { full_name: source.repo } });
          yield* tasks.value
            .triggerWebhook({
              hookId: hook.id,
              token: hook.token,
              method: "POST",
              path: `${ScheduledTaskService.WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(hook.id)}`,
              query: "",
              headers: { "content-type": "application/json", "x-caveman-source": "github" },
              body: new TextEncoder().encode(bodyText),
              bodyText,
              // The comment is the signed-in user's own (mentionsToRun), so "@caveman run /review"
              // keeps its command; the issue's title and the rest stay framed as request data.
              trustedPaths: GITHUB_MENTION_TRUSTED_PATHS,
            })
            .pipe(Effect.ignore);
        }
        const newest = comments.reduce((max, c) => (c.created_at > max ? c.created_at : max), source.since);
        seen.set(taskId, { ...source, since: newest });
      }
      yield* sourcesLock.withPermits(1)(
        sources.pipe(
          Effect.flatMap((now) => {
            const next = { ...now };
            for (const [taskId, source] of seen) {
              // Turned on, saved or deleted since this check read it: that stands.
              if (!sameSource(now[taskId], all[taskId])) continue;
              if (source === undefined) delete next[taskId];
              else next[taskId] = source;
            }
            return putSources(next);
          }),
        ),
      );
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("GitHub automation check failed", cause)));
    yield* pollGitHub.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);

    // ------------------------------------------------------------ automation files
    const projectsOpt = yield* Effect.serviceOption(AutomationProjects);
    const triggersOpt = yield* Effect.serviceOption(AutomationTriggers);
    const runnerOpt = yield* Effect.serviceOption(AutomationRunner);
    const readEnv = yield* makeEnvReader;
    const needFiles: Effect.Effect<AutomationProjects["Service"], ProtocolError> = Option.isNone(projectsOpt)
      ? Effect.fail(fail("unsupported", "This runtime does not serve automation files; update Caveman Code."))
      : Effect.succeed(projectsOpt.value);
    const rootOf = (projectId: string) => needFiles.pipe(Effect.flatMap((files) => files.rootOf(projectId).pipe(Effect.mapError(filesProblem))));
    const envFor = (root: string) =>
      needFiles.pipe(
        Effect.flatMap((files) => files.branch(root)),
        Effect.flatMap((view): Effect.Effect<EnvSnapshot> => readEnv(view.workflow ? "github-actions" : "code")),
      );
    const runsOf = (projectId: string) =>
      Option.isNone(runnerOpt) ? Effect.succeed([] as ReadonlyArray<AutomationRunSummary>) : runnerOpt.value.runs({ projectId, limit: 200 });

    /** Every file automation of a project, as automation.list shows it: its checkout's, then its drafts in other worktrees. */
    const fileList = (projectId: string, root: string) =>
      Effect.gen(function* () {
        const files = yield* needFiles;
        const env = yield* envFor(root);
        const check = yield* files.check(root, undefined, env);
        const view = yield* files.branch(root);
        const candidates = Option.isSome(triggersOpt) ? yield* triggersOpt.value.candidates(projectId, root) : ([] as ReadonlyArray<Candidate>);
        const runs = yield* runsOf(projectId);
        const own = rowsOf({ projectId, ref: projectId, check, view, env, candidates, runs });
        const byWorktree = new Map<string, { worktree: Worktree; paths: Set<string> }>();
        for (const d of yield* files.drafts(root)) {
          const seen = byWorktree.get(d.worktree.path) ?? { worktree: d.worktree, paths: new Set<string>() };
          seen.paths.add(d.path);
          byWorktree.set(d.worktree.path, seen);
        }
        const drafts = yield* Effect.forEach([...byWorktree.values()], ({ worktree, paths }) =>
          files.check(worktree.path, undefined, env).pipe(
            Effect.map((draftCheck) => rowsOf({ projectId, ref: draftProjectRef(projectId, worktree.branch), check: draftCheck, view, env, candidates: [], runs, draft: { worktree, paths } })),
          ),
        );
        return [...own, ...drafts.flat()];
      });

    /** automation.list's rows for one checkout's check: the project's own, or (draft) only the files a worktree adds or changes. */
    const rowsOf = (input: {
      readonly projectId: string;
      /** The project, or `<project>@<branch>` for a draft: what the rows' ids carry, so every call on them reads that worktree. */
      readonly ref: string;
      readonly check: ProjectCheck;
      readonly view: BranchView;
      readonly env: EnvSnapshot;
      readonly candidates: ReadonlyArray<Candidate>;
      readonly runs: ReadonlyArray<AutomationRunSummary>;
      readonly draft?: { readonly worktree: Worktree; readonly paths: ReadonlySet<string> };
    }): Array<typeof Automation.Type> => {
        const { projectId, check, view, env, candidates, runs, draft } = input;
        const inDraft = (file: string) => draft === undefined || draft.paths.has(file);
        const draftFields = draft === undefined ? {} : { worktree: { branch: draft.worktree.branch, path: draft.worktree.path } };
        const now = Date.now();
        // A default branch git could not read says nothing about which files are on it; a draft is on no branch of it.
        const onBranch = draft !== undefined ? new Set<string>() : view.unreadable ? undefined : new Set(view.sources?.files.map((f) => f.path) ?? []);
        const agents = new Map(check.agents.map((a) => [a.name, a]));
        const shown: Array<{ automation: LoadedAutomation; diagnostics: number; errors: number }> = check.automations.filter((a) => inDraft(a.path)).map((a) => {
          const own = diagnosticsOf(check, a);
          return { automation: a, diagnostics: own.length, errors: own.filter((d) => d.severity === "error").length };
        });
        // A Project automation deleted here but still on the default branch still fires: list it too.
        for (const c of candidates) {
          if (c.revision !== undefined && !shown.some((s) => s.automation.name === c.name && s.automation.scope === c.scope)) shown.push({ automation: c.revision.automation, diagnostics: 0, errors: 0 });
        }
        // A file that does not load is listed too, with its problems, so an edit that breaks it never makes it vanish.
        const broken = new Map<string, { scope: Scope; name: string; count: number; errors: number }>();
        for (const d of check.diagnostics) {
          const match = /^\.caveman\/(local\/)?automations\/([a-z][a-z0-9_-]{0,39})\.yaml$/.exec(d.path);
          if (match === null || !inDraft(d.path) || shown.some((s) => s.automation.path === d.path)) continue;
          const seen = broken.get(d.path);
          broken.set(d.path, { scope: match[1] ? "me" : "project", name: match[2]!, count: (seen?.count ?? 0) + 1, errors: (seen?.errors ?? 0) + (d.severity === "error" ? 1 : 0) });
        }
        const runsOn = view.workflow ? ("github_actions" as const) : ("this_mac" as const);
        const unloaded = [...broken].map(([file, { scope, name, count, errors }]): typeof Automation.Type => {
          const id = fileAutomationId(input.ref, scope, name);
          const status = candidates.find((c) => c.id === id)?.status ?? { enabled: false };
          return {
            id,
            title: name,
            prompt: "",
            enabled: status.enabled,
            trigger: { type: "file", kinds: ["manual"], words: ["Does not load: fix its errors"] },
            project_id: projectId,
            engine: env.defaultEngine as EngineId,
            model: "default",
            next_run_at: null,
            last_run_at: null,
            last_status: "never",
            last_error: status.problem ?? `${file} has errors; it does not run until they are fixed.`,
            run_count: 0,
            source: "file",
            scope,
            path: file,
            steps: [],
            diagnostics: count,
            errors,
            ...(view.branch ? { default_branch: view.branch.name } : {}),
            ...(scope === "project" && onBranch !== undefined ? { on_default_branch: onBranch.has(file) } : {}),
            ...draftFields,
            last30: last30([], now),
            spend_30d_usd: 0,
            runs_running: 0,
          };
        });
        return [...unloaded, ...shown.map(({ automation, diagnostics, errors }): typeof Automation.Type => {
          const id = fileAutomationId(input.ref, automation.scope, automation.name);
          const status = candidates.find((c) => c.id === id)?.status ?? { enabled: false };
          // An automation with no triggers runs by hand only: where triggers fire, and whether it is on main, say nothing about it.
          const triggered = automation.file.on?.github !== undefined || automation.file.on?.schedule !== undefined;
          const takes = subjectKindOf(automation.file);
          const inputs = Object.entries(automation.file.inputs ?? {}).map(([name, input]) => ({
            name,
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.required !== undefined ? { required: input.required } : {}),
            ...(input.default !== undefined ? { default: input.default } : {}),
          }));
          // A draft's manual runs are the automation's own (runFile records them under the project): its history is shared.
          const mine = runs.filter((r) => r.automation_id === fileAutomationId(projectId, automation.scope, automation.name));
          const finished = mine.filter((r) => r.ended_at !== null);
          const last = mine[0];
          const steps = Object.entries(automation.file.steps).map(([name, step]) => {
            const agent = step.agent === undefined ? undefined : agents.get(step.agent);
            return { name, ...(step.agent ? { agent: step.agent } : {}), model: step.model ?? agent?.model ?? "default", computer: step.computer ?? "readonly" };
          });
          const first = Object.values(automation.file.steps)[0];
          const engine = (first?.agent === undefined ? undefined : agents.get(first.agent)?.engine) ?? env.defaultEngine;
          const reports = automation.file.outputs?.chief;
          const schedule = automation.file.on?.schedule;
          const { until, ...unbounded } = schedule ?? {};
          // Its last day is said apart (the routine's row shows it beside the schedule).
          const scheduleSaid = schedule === undefined ? undefined : scheduleWords(unbounded);
          return {
            id,
            title: automation.name,
            prompt: automation.file.description ?? "",
            enabled: status.enabled,
            trigger: { type: "file", kinds: triggerKinds(automation.file), words: triggerWords(automation.file) },
            host: hostOf(automation.file),
            project_id: projectId,
            engine: engine as EngineId,
            model: steps[0]?.model ?? "default",
            next_run_at: status.nextRunAt === undefined ? null : new Date(status.nextRunAt).toISOString(),
            last_run_at: last?.started_at ?? null,
            last_status: last === undefined ? "never" : RUNNING.has(last.status) ? "running" : last.status === "succeeded" ? "succeeded" : "failed",
            last_error: status.problem ?? (last !== undefined && last.status === "failed" ? (last.reason ?? "failed") : null),
            run_count: mine.length,
            source: "file",
            scope: automation.scope,
            path: automation.path,
            ...(automation.file.description !== undefined ? { description: automation.file.description } : {}),
            steps,
            diagnostics,
            errors,
            ...(inputs.length > 0 ? { inputs } : {}),
            ...(status.enabled && triggered && status.problem ? { triggers_off_reason: status.problem } : {}),
            ...(view.branch ? { default_branch: view.branch.name } : {}),
            ...(triggered ? { runs_on: automation.scope === "me" ? ("this_mac" as const) : runsOn } : {}),
            ...(takes ? { takes_subject: takes } : {}),
            ...(automation.scope === "project" && triggered && onBranch !== undefined ? { on_default_branch: onBranch.has(automation.path) } : {}),
            ...draftFields,
            last30: last30(finished, now),
            spend_30d_usd: Math.round(mine.filter((r) => now - Date.parse(r.started_at) < 30 * DAY_MS).reduce((sum, r) => sum + r.spent_usd, 0) * 100) / 100,
            runs_running: mine.filter((r) => RUNNING.has(r.status)).length,
            ...(reports === undefined
              ? {}
              : { routine: { step: reports.from, ...(scheduleSaid === undefined ? {} : { schedule: scheduleSaid }), ...(until === undefined ? {} : { until }), ...(reports.to === undefined ? {} : { chief_id: reports.to }) } }),
          };
        })];
    };
    const oneFile = (projectId: string, scope: Scope, name: string) =>
      Effect.gen(function* () {
        // A draft's row is in its project's list (with its worktree), found by its own id.
        const project = splitProjectRef(projectId).projectId;
        const root = yield* rootOf(project);
        const id = fileAutomationId(projectId, scope, name);
        const found = (yield* fileList(project, root)).find((a) => a.id === id);
        return found ?? (yield* Effect.fail(fail("not_found", `No ${scope === "me" ? "Me" : "Project"} automation ${name}; create it from a template or with automation.create.`)));
      });
    const fileId = (id: string) => {
      const parsed = parseFileAutomationId(id);
      return parsed === undefined ? Effect.fail(fail("invalid_params", `${id} is not an automation id; take one from automation.list.`)) : Effect.succeed(parsed);
    };
    const needTriggers: Effect.Effect<AutomationTriggers["Service"], ProtocolError> = Option.isNone(triggersOpt)
      ? Effect.fail(fail("unsupported", "This runtime cannot turn automation files on or off; update Caveman Code."))
      : Effect.succeed(triggersOpt.value);
    const projectRows = (projectId: string | undefined) =>
      needFiles.pipe(
        Effect.flatMap((files) => files.projects),
        Effect.map((rows) => rows.filter((r) => projectId === undefined || r.projectId === projectId)),
      );

    /** A manual run of a file automation: the working tree's copy, its inputs checked, outputs a dry run unless `apply`. */
    const runFile = (id: string, inputs: Readonly<Record<string, string>> | undefined, apply: boolean | undefined, subject: string | undefined) =>
      Effect.gen(function* () {
        const { projectId, scope, name } = yield* fileId(id);
        const files = yield* needFiles;
        const root = yield* rootOf(projectId);
        const { revision, check } = yield* files.revisionAt(root, name, scope, "working_tree");
        if (revision === undefined) return yield* Effect.fail(fail("not_found", `No ${scope === "me" ? "Me" : "Project"} automation ${name}; check its file name with automation.list.`));
        const errors = blockingErrors(check, revision.automation);
        if (errors.length > 0) {
          const first = errors[0]!;
          return yield* Effect.fail(fail("invalid_state", `${name} has ${errors.length === 1 ? "an error" : `${errors.length} errors`} and cannot run: ${first.path}:${first.line}:${first.column} ${first.message}`));
        }
        const declared = revision.automation.file.inputs ?? {};
        const given = { ...inputs };
        const unknown = Object.keys(given).filter((key) => !(key in declared));
        if (unknown.length > 0) {
          const names = Object.keys(declared);
          return yield* Effect.fail(fail("invalid_params", `${name} has no input ${unknown[0]}; ${names.length > 0 ? `its inputs are ${names.join(", ")}` : "it takes no inputs"}.`));
        }
        for (const [key, input] of Object.entries(declared)) {
          if (given[key] === undefined && input.default !== undefined) given[key] = input.default;
          if (given[key] === undefined && input.required === true) {
            return yield* Effect.fail(fail("invalid_params", `${name} needs the input ${key}${input.description ? ` (${input.description})` : ""}; pass it as ${key}=<value>.`));
          }
        }
        if (Option.isNone(runnerOpt)) return yield* Effect.fail(fail("unsupported", "This runtime cannot run automations yet; update Caveman Code."));
        const trigger = Option.isSome(triggersOpt)
          ? yield* triggersOpt.value.manualTrigger({ root, automation: revision.automation, subject }).pipe(Effect.mapError(filesProblem))
          : subject === undefined
            ? { kind: "manual" as const, subject: `manual:${ulid()}`, trusted: true, receivedAt: new Date().toISOString() }
            : yield* Effect.fail(fail("unsupported", "This runtime cannot run an automation on an issue; update Caveman Code."));
        // A draft runs its worktree's file, recorded under the project itself: the run, its branch and its outputs are the project's.
        const result = yield* runnerOpt.value.admit({ projectId: splitProjectRef(projectId).projectId, revision, trigger, inputs: given, apply: apply ?? false });
        if ("refused" in result) return yield* Effect.fail(fail(result.refused === "engine_unavailable" ? "unsupported" : "invalid_state", result.message));
        const automation = yield* oneFile(projectId, scope, name);
        return { ...automation, run_id: result.runId };
      });


    return {
      "automation.list": (p) =>
        Effect.gen(function* () {
          const legacy = Option.isNone(tasks)
            ? []
            : yield* listAll.pipe(
                Effect.flatMap(({ tasks: all }) => Effect.forEach(all.filter((t) => p.project_id === undefined || t.projectId === p.project_id), wire)),
              );
          const files = Option.isNone(projectsOpt)
            ? []
            : (yield* Effect.forEach(yield* projectRows(p.project_id), ({ projectId, root }) => fileList(projectId, root), { concurrency: 4 })).flat();
          const onCloud = Option.isNone(cloudOpt)
            ? []
            : (yield* cloudOpt.value.list()).flatMap((schedule) => {
                const wired = p.project_id === undefined || schedule.projectId === p.project_id ? cloudAutomationOf(schedule) : undefined;
                return wired === undefined ? [] : [wired];
              });
          // Soonest first, then by name.
          const automations = [...legacy, ...files, ...onCloud].sort(
            (a, b) => (a.next_run_at ?? "~").localeCompare(b.next_run_at ?? "~") || a.title.localeCompare(b.title),
          );
          return { automations };
        }),
      "automation.check": (p) =>
        Effect.gen(function* () {
          const root = yield* rootOf(p.project_id);
          const files = yield* needFiles;
          const check = yield* files.check(root, p.files, yield* envFor(root));
          return { diagnostics: [...check.diagnostics] };
        }),
      "automation.explain": (p) =>
        Effect.gen(function* () {
          const root = yield* rootOf(p.project_id);
          const files = yield* needFiles;
          const env = yield* envFor(root);
          const check = yield* files.check(root, undefined, env);
          const automation = check.automations.find((a) => a.name === p.name && a.scope === p.scope);
          if (automation === undefined) {
            const others = check.automations.map((a) => a.name);
            return yield* Effect.fail(
              fail("not_found", `No ${p.scope === "me" ? "Me" : "Project"} automation ${p.name}${check.diagnostics.some((d) => d.path.endsWith(`/${p.name}.yaml`)) ? " that loads; run automation.check for why" : others.length > 0 ? `; there is ${others.join(", ")}` : "; create one from a template"}.`),
            );
          }
          if (p.step !== undefined && automation.file.steps[p.step] === undefined) {
            return yield* Effect.fail(fail("invalid_params", `${p.name} has no step ${p.step}; its steps are ${Object.keys(automation.file.steps).join(", ")}.`));
          }
          const explanation = explain({ automation, agents: check.agents, env, ...(p.step !== undefined ? { step: p.step } : {}) });
          return { explanation, text: renderExplain(explanation) };
        }),
      "automation.templates": () => Effect.succeed({ templates: templates.map(templateSummary) }),
      "automation.create": (p) =>
        Effect.gen(function* () {
          const root = yield* rootOf(p.project_id);
          const files = yield* needFiles;
          const created = yield* Effect.tryPromise({
            try: () => {
              if ("template" in p.from) {
                const id = p.from.template;
                const template = templates.find((t) => t.id === id);
                if (template === undefined) {
                  throw new AutomationFilesError({ reason: "not_found", message: `No template ${id}; pick one from automation.templates.` });
                }
                return createFromTemplate(root, template, p.scope);
              }
              return createFromText(root, p.from.name, p.from.text, p.scope);
            },
            catch: (error) => (error instanceof AutomationFilesError ? filesProblem(error) : fail("invalid_state", `The files could not be written: ${(error as Error).message}.`)),
          });
          yield* files.invalidate(root);
          // Made here by the person: it is on, bound to what they just created (rule 9). A draft turns on when it merges.
          if (Option.isSome(triggersOpt) && splitProjectRef(p.project_id).branch === undefined) yield* triggersOpt.value.setEnabled({ projectId: p.project_id, root, name: created.name, scope: p.scope, enabled: true });
          const automation = yield* oneFile(p.project_id, p.scope, created.name);
          return { automation, written: [...created.written], ...(created.renamed.length > 0 ? { renamed: created.renamed.map((r) => ({ ...r })) } : {}) };
        }),
      "automation.file_read": (p) =>
        Effect.gen(function* () {
          const root = yield* rootOf(p.project_id);
          const files = yield* needFiles;
          return { text: yield* files.read(root, p.path).pipe(Effect.mapError(filesProblem)) };
        }),
      "automation.file_write": (p) =>
        Effect.gen(function* () {
          const root = yield* rootOf(p.project_id);
          const files = yield* needFiles;
          yield* files.write(root, p.path, p.text).pipe(Effect.mapError(filesProblem));
          // F-1: a Me file the person saves here is on, bound to what they saved; one edited any other way is not.
          const me = ME_FILE.exec(p.path);
          if (me !== null && Option.isSome(triggersOpt) && splitProjectRef(p.project_id).branch === undefined) yield* triggersOpt.value.saved({ projectId: p.project_id, root, name: me[1]! });
          const check = yield* files.check(root, undefined, yield* envFor(root));
          return { diagnostics: [...check.diagnostics] };
        }),
      "automation.save": (p) =>
        Effect.gen(function* () {
          // BUILD D9: new automations are files; one saved in the app before files can still be edited.
          if (p.id === undefined) return yield* Effect.fail(fail("invalid_params", "New automations are files; create one with automation.create (a template, or the file's text)."));
          if (p.id.startsWith("file:")) return yield* Effect.fail(fail("invalid_params", "An automation file is edited as a file; use automation.file_write."));
          if (isCloud(p.id)) {
            if (p.trigger.type === "webhook" || p.trigger.type === "github_mention")
              return yield* Effect.fail(fail("invalid_params", "A schedule on Cloud runs at times; a webhook or a GitHub mention runs on this computer."));
            const cloudService = yield* needCloud;
            const changed = yield* cloudService
              .update(p.id, { title: p.title, prompt: p.prompt, schedule: scheduleFor(p.trigger) as unknown as Record<string, unknown>, enabled: p.enabled }, "person")
              .pipe(Effect.mapError(cloudError));
            return yield* cloudWire(changed);
          }
          const problem = p.trigger.type === "webhook" ? dedupeProblem(p.trigger.dedupe) : undefined;
          if (problem !== undefined) return yield* Effect.fail(fail("invalid_params", problem));
          const service = yield* need;
          const { modelSelection, runtimeMode } = yield* deps.launch(p.engine, p.model, p.access, p.project_id);
          const isGitHub = p.trigger.type === "github_mention";
          const id = p.id;
          const task = yield* Effect.gen(function* () {
            const was = yield* one(id);
            // An agent's wake-up stays bound to its chat when the person edits it here.
            const bound = was.threadId != null && was.projectId === p.project_id ? was : undefined;
            const { task } = yield* service
              .upsert({
                ...(p.id === undefined ? {} : { id: ScheduledTaskId.make(p.id), requireExisting: true }),
                title: p.title,
                prompt: isGitHub ? `${p.prompt}${GITHUB_MENTION_TEMPLATE}` : p.prompt,
                enabled: p.enabled,
                schedule: scheduleFor(p.trigger),
                projectId: ProjectId.make(p.project_id),
                threadId: bound?.threadId ?? null,
                // Each run in a worktree of its own, from where the project's checkout is now; a bound one in its chat.
                workspaceStrategy: bound?.workspaceStrategy ?? { type: "worktree", baseRef: "HEAD" },
                modelSelection,
                runtimeMode,
                interactionMode: bound?.interactionMode ?? "default",
                createdBy: was.createdBy ?? "user",
                creationSource: "web",
              })
              .pipe(Effect.mapError(taskError));
            const all = yield* sources;
            if (p.trigger.type === "github_mention") {
              // Only comments made from now on start a run; one already on keeps hearing its repository where it was.
              const kept = was.enabled && all[task.id]?.repo === p.trigger.repo ? all[task.id]!.since : new Date().toISOString();
              yield* putSources({ ...all, [task.id]: { repo: p.trigger.repo, since: kept } });
            } else if (all[task.id] !== undefined) {
              const { [task.id]: _dropped, ...rest } = all;
              yield* putSources(rest);
            }
            return task;
          }).pipe(sourcesLock.withPermits(1));
          yield* setFollowsDefault(task.id, p.model === undefined);
          return yield* wire(task);
        }),
      "automation.set_enabled": (p) =>
        isCloud(p.id)
          ? needCloud.pipe(Effect.flatMap((cloud) => cloud.update(p.id, { enabled: p.enabled }, "person").pipe(Effect.mapError(cloudError))), Effect.flatMap(cloudWire))
          : p.id.startsWith("file:")
          ? Effect.gen(function* () {
              const { projectId, scope, name } = yield* fileId(p.id);
              const draft = splitProjectRef(projectId).branch;
              if (draft !== undefined) {
                return yield* Effect.fail(fail("invalid_state", `${name} is a draft on ${draft}: run it by hand now, and merge it to turn it on.`));
              }
              const root = yield* rootOf(projectId);
              yield* (yield* needTriggers).setEnabled({ projectId, root, name, scope, enabled: p.enabled });
              return yield* oneFile(projectId, scope, name);
            })
          : Effect.gen(function* () {
              const service = yield* need;
              const was = yield* one(p.id);
              const { task } = yield* service.setEnabled({ id: ScheduledTaskId.make(p.id), enabled: p.enabled }).pipe(Effect.mapError(taskError));
              if (task.enabled && !was.enabled) yield* hearFromNow(task.id);
              return task;
            }).pipe(sourcesLock.withPermits(1), Effect.flatMap(wire)),
      "automation.delete": (p) =>
        isCloud(p.id)
          ? needCloud.pipe(Effect.flatMap((cloud) => cloud.remove(p.id).pipe(Effect.mapError(cloudError))), Effect.as({}))
          : p.id.startsWith("file:")
          ? Effect.gen(function* () {
              const { projectId, scope, name } = yield* fileId(p.id);
              const root = yield* rootOf(projectId);
              const files = yield* needFiles;
              const rel = scope === "me" ? `.caveman/local/automations/${name}.yaml` : `.caveman/automations/${name}.yaml`;
              yield* Effect.tryPromise({
                try: () => editablePath(root, rel, "write").then((abs) => fs.promises.rm(abs, { force: true })),
                catch: (error) => (error instanceof AutomationFilesError ? filesProblem(error) : fail("invalid_state", `${rel} could not be deleted: ${(error as Error).message}.`)),
              });
              yield* files.invalidate(root);
              if (Option.isSome(triggersOpt)) yield* triggersOpt.value.forget(p.id);
              return {};
            })
          : need.pipe(
          Effect.flatMap((service) => service.delete({ id: ScheduledTaskId.make(p.id) }).pipe(Effect.mapError(taskError))),
          Effect.andThen(sources),
          Effect.flatMap((all) => {
            const { [p.id]: _dropped, ...rest } = all;
            return putSources(rest);
          }),
          sourcesLock.withPermits(1),
          Effect.andThen(setFollowsDefault(p.id, false)),
          Effect.as({}),
        ),
      "automation.allow": (p) =>
        isCloud(p.id)
          ? needCloud.pipe(Effect.flatMap((cloud) => cloud.allow(p.id).pipe(Effect.mapError(cloudError))), Effect.flatMap(cloudWire))
          : Effect.fail(fail("invalid_params", "Only a schedule an agent set to run on Cloud waits to be allowed.")),
      "automation.run": (p) =>
        isCloud(p.id)
          ? needCloud.pipe(Effect.flatMap((cloud) => cloud.runNow(p.id).pipe(Effect.mapError(cloudError))), Effect.flatMap(cloudWire))
          : p.id.startsWith("file:")
          ? runFile(p.id, p.inputs, p.apply, p.subject)
          : need.pipe(
          Effect.flatMap((service) => service.runNow({ id: ScheduledTaskId.make(p.id) }).pipe(Effect.mapError(taskError))),
          Effect.flatMap(({ task }) => wire(task)),
        ),
      "automation.rotate_url": (p) =>
        p.id.startsWith("file:")
          ? Effect.fail(fail("invalid_params", "An automation file has no URL; Caveman Code does not serve file webhooks yet."))
          : one(p.id).pipe(
          Effect.flatMap((task) =>
            task.schedule.type === "webhook" ? Effect.succeed(task) : Effect.fail(fail("invalid_params", `${task.title} has no URL`)),
          ),
          Effect.andThen(need),
          Effect.flatMap((service) => service.rotateWebhookToken({ id: ScheduledTaskId.make(p.id) }).pipe(Effect.mapError(taskError))),
          Effect.flatMap(({ task }) => wire(task)),
        ),
      "automation.set_webhook_rules": (p) =>
        Effect.gen(function* () {
          if (p.id.startsWith("file:")) return yield* Effect.fail(fail("invalid_params", "An automation file's webhook takes no settings yet; write webhook: {}."));
          const problem = dedupeProblem(p.dedupe);
          if (problem !== undefined) return yield* Effect.fail(fail("invalid_params", problem));
          const task = yield* one(p.id);
          const all = yield* sources;
          const s = task.schedule;
          if (s.type !== "webhook" || all[task.id] !== undefined) return yield* Effect.fail(fail("invalid_params", `${task.title} is not started by a webhook`));
          if (p.filters === undefined && p.dedupe === undefined) return yield* wire(task);
          const service = yield* need;
          // Everything else as stored: its signature without the secret keeps the stored secret, and its model,
          // permissions, workspace and history are untouched (a save would take them from the form).
          const { task: saved } = yield* service
            .upsert({
              id: task.id,
              requireExisting: true,
              title: task.title,
              prompt: task.prompt,
              enabled: task.enabled,
              schedule: {
                type: "webhook",
                signature: s.signature,
                maxDeliveryAgeMinutes: s.maxDeliveryAgeMinutes ?? null,
                ...(p.filters === undefined ? {} : { filters: p.filters.map(storedFilter) }),
                ...(p.dedupe === undefined ? {} : { dedupe: storedDedupe({ ...p.dedupe, ...(p.dedupe.replay_key ? { replay_key: p.dedupe.replay_key.trim() } : {}), ...(p.dedupe.coalesce_key ? { coalesce_key: p.dedupe.coalesce_key.trim() } : {}) }) }),
              },
              projectId: task.projectId,
              threadId: task.threadId,
              workspaceStrategy: task.workspaceStrategy,
              modelSelection: task.modelSelection,
              runtimeMode: task.runtimeMode,
              interactionMode: task.interactionMode,
              creationSource: task.creationSource,
            })
            .pipe(Effect.mapError(taskError));
          return yield* wire(saved);
        }),
      "automation.deliveries": (p) =>
        p.id.startsWith("file:")
          ? needTriggers.pipe(
              Effect.flatMap((triggers) => triggers.deliveries(p.id)),
              Effect.map((records) => ({ deliveries: records.map(deliveryOf) })),
            )
          : need.pipe(
          Effect.flatMap((service) => service.listWebhookDeliveries({ id: ScheduledTaskId.make(p.id), acceptAnyOutcome: true }).pipe(Effect.mapError(taskError))),
          Effect.map(({ deliveries }) => ({
            deliveries: deliveries.map((d) => ({ id: d.id, received_at: d.receivedAt, outcome: d.outcome, error: d.error })),
          })),
        ),
    } satisfies { readonly [M in AutomationMethod]: Handler<M> };
  });
