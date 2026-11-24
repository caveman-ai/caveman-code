// Triggers on This Mac: schedules (one scheduler source, timezone-aware) and GitHub events (one poll per
// repository per minute, github.ts), each admitted through the AutomationRunner with the revision it fires.
//
// Security rules applied here, before the runner sees anything (SEMANTICS §13):
// 1. A Project automation's triggers run the default branch's copy of its files; a file not on the default
//    branch never fires. Me files are the person's own and fire from the working tree, never from git: one
//    that git tracks does not load (files.ts), and one is on only when the app saved it or the person turned
//    it on (F-1), so a file that arrives by a pull, a checkout or another agent never fires by itself.
// 2-3. GitHub events from outsiders and forks are refused (github.ts `route`), and text by an outsider is
//    withheld from the payload; untrusted text never meets a step with a checkout on This Mac.
// 9. Turning an automation on (or saving a Me file in the app) binds it to its authority (engines, computers,
//    commands, checks, outputs, triggers). When the copy its triggers run (the default branch's, or a Me file edited
//    any other way) changes any of those, its triggers stop until it is turned on again. Prompts and models
//    may change freely.
// SEMANTICS 8.6: a repository whose default branch has the Caveman workflow fires Project triggers in
// GitHub Actions, never here.
//
// What the files never hold, the runtime's state does: on or off, the next schedule fire, the poll cursors,
// and every delivery (what arrived, for which automation, what happened to it).
import { createHash } from "node:crypto";

import { computerOf, hostOf, rungsOf, subjectKindOf, type LoadedAutomation, type ProjectCheck, type Scope } from "@caveman-app/automations";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@caveman-app/shared/git";
import * as GitHubCredentials from "@caveman-app/source-control-github/server/GitHubCredentials";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { Scheduler } from "../scheduling/Scheduler.ts";
import { SessionStore } from "../session-protocol/store.ts";
import { AutomationFilesError, AutomationProjects, blockingErrors, checkSources, fetchDefaultBranch, git, revisionFrom, type BranchView } from "./files.ts";
import { byOf, mergeWants, pollRepo, route, subjectPayload, wantOf, type GitHubApi, type RepoCursor } from "./github.ts";
import { isWallClock, LATE_GRACE_MS, nextFire } from "./schedule.ts";
import { AutomationRunner, type Revision, type TriggerEvent } from "./services.ts";

/** A file automation's id: `file:<project_id>:<scope>:<name>`. Project ids hold colons, so parse from the right. */
export const fileAutomationId = (projectId: string, scope: Scope, name: string) => `file:${projectId}:${scope}:${name}`;
export function parseFileAutomationId(id: string): { readonly projectId: string; readonly scope: Scope; readonly name: string } | undefined {
  const match = /^file:(.+):(me|project):([a-z][a-z0-9_-]{0,39})$/.exec(id);
  return match === null ? undefined : { projectId: match[1]!, scope: match[2] as Scope, name: match[3]! };
}

/** A fresh ULID: 48 bits of time, 80 of randomness, Crockford base32. Manual runs' subjects (SEMANTICS §0). */
export function ulid(now = Date.now()): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = alphabet[t % 32] + time;
  const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => alphabet[b % 32]).join("");
  return time + random;
}

/** What turning it on vouches for (rule 9): engines, computers, commands, checks, outputs and triggers; not prompts or models. */
export function authorityOf(revision: Pick<Revision, "automation" | "agents">): string {
  const agents = new Map(revision.agents.map((a) => [a.name, a]));
  const file = revision.automation.file;
  const engineOf = (agent: string | undefined) => (agent === undefined ? "default" : (agents.get(agent)?.engine ?? "default"));
  const steps = Object.entries(file.steps).map(([name, step]) => {
    // Attempts 2 and later run on a rung's engine; a rung that names none stays on the step's.
    const escalate = rungsOf(step.escalate).flatMap((rung) => (rung.engine === undefined ? [] : [rung.engine]));
    return {
      name,
      engine: engineOf(step.agent),
      computer: computerOf(step),
      checks: (step.checks ?? []).map((c) => (typeof c === "string" ? c : `agent:${c.agent}:${engineOf(c.agent)}`)),
      // A command step runs with the person's git login (stepEnv), so its command is part of what they vouch for.
      ...(step.run === undefined ? {} : { run: step.run }),
      // Left out when empty, so what was turned on before rungs were counted still matches.
      ...(escalate.length === 0 ? {} : { escalate }),
    };
  });
  return createHash("sha256").update(JSON.stringify({ on: file.on ?? null, steps, outputs: file.outputs ?? null })).digest("hex");
}

export interface DeliveryRecord {
  readonly id: string;
  readonly at: string;
  readonly kind: TriggerEvent["kind"];
  readonly event?: string;
  readonly subject: string;
  readonly subjectTitle?: string;
  /** skipped: a schedule tick while its last run still went (skipped_overlap), or GitHub events past what a poll reads back. */
  readonly outcome: "started" | "refused" | "skipped";
  /** The run's reason code when refused (SEMANTICS §12). */
  readonly reason?: string;
  /** One sentence: what happened and what to do. */
  readonly message?: string;
  readonly runId?: string;
  /** GitHub: who fired it (`maya (member)`), and who wrote the issue when that is someone else (B2). */
  readonly by?: string;
}

/** How one automation's triggers stand right now. */
export interface TriggerStatus {
  readonly enabled: boolean;
  /** Why its triggers are not firing although it is on (not on the default branch, fired in GitHub Actions, changed since turned on, errors, no GitHub sign-in). */
  readonly problem?: string;
  readonly nextRunAt?: number;
}

interface State {
  enabled: Record<string, { on: boolean; authority?: string }>;
  /** `runs`: the fires this schedule made since its key last changed, which its count limits. */
  schedule: Record<string, { key: string; next?: number; runs?: number }>;
  github: Record<string, RepoCursor>;
  deliveries: Record<string, DeliveryRecord[]>;
}
const KEYS = { enabled: "automation_files_enabled", schedule: "automation_files_schedule", github: "automation_files_github", deliveries: "automation_files_deliveries" } as const;
const MAX_DELIVERIES = 50;
const POLL_EVERY_MS = 60_000;
/** How often a project with a Project automation turned on fetches its default branch (K9). */
const FETCH_EVERY_MS = 5 * 60_000;

/** One automation as the triggers see it: the copy its triggers run, and whether they may. */
export interface Candidate {
  readonly id: string;
  readonly name: string;
  readonly scope: Scope;
  readonly revision?: Revision;
  /** Its triggers may fire: on, on the default branch (Project), home here, no errors, unchanged since turned on. */
  readonly live: boolean;
  /** A Project automation whose default branch git could not read: not live, yet not off, so its triggers keep their place. */
  readonly unknown?: true;
  readonly status: TriggerStatus;
}

export class AutomationTriggers extends Context.Service<
  AutomationTriggers,
  {
    /** Each automation of a project, with the copy its triggers run and how they stand. */
    readonly candidates: (projectId: string, root: string) => Effect.Effect<ReadonlyArray<Candidate>>;
    /** On binds an automation to its working tree's authority (rule 9); off stops its triggers and cancels its runs (§8.5). */
    readonly setEnabled: (input: { readonly projectId: string; readonly root: string; readonly name: string; readonly scope: Scope; readonly enabled: boolean }) => Effect.Effect<void>;
    /** The app saved this Me file: it is on (unless the person turned it off), bound to the authority just saved (F-1). */
    readonly saved: (input: { readonly projectId: string; readonly root: string; readonly name: string }) => Effect.Effect<void>;
    /**
     * A manual run's trigger: about nothing (`manual:<ulid>`), or about an issue or pull request of this repo's origin,
     * fetched and normalized like a trigger's payload, trusted because the person ran it (F-6).
     */
    readonly manualTrigger: (input: { readonly root: string; readonly automation: LoadedAutomation; readonly subject?: string | undefined }) => Effect.Effect<TriggerEvent, AutomationFilesError>;
    /** Drops what the runtime keeps for an automation (it was deleted), and cancels its runs. */
    readonly forget: (id: string) => Effect.Effect<void>;
    readonly deliveries: (id: string) => Effect.Effect<ReadonlyArray<DeliveryRecord>>;
    /** One schedule pass (the scheduler source runs it every 5 s). */
    readonly tick: Effect.Effect<void>;
    /** The earliest next fire (epoch ms) of a live schedule trigger here, or none: what a sleeping Cloud computer wakes for. */
    readonly nextScheduled: Effect.Effect<number | undefined>;
    /** One GitHub poll of every watched repository (the scheduler source runs it each minute). */
    readonly poll: Effect.Effect<void>;
  }
>()("caveman/automations/AutomationTriggers") {}

export interface TriggerOptions {
  /** GitHub's REST API with this token; tests pass recorded answers. */
  readonly api?: (token: string) => GitHubApi;
  readonly now?: () => number;
}

/** GitHub's REST API, conditional requests only where asked. */
export const githubApi =
  (token: string): GitHubApi =>
  async (url, etag) => {
    const response = await fetch(`https://api.github.com${url}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "caveman-code",
        ...(etag ? { "if-none-match": etag } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    // A 403 with requests left is a refusal, not the rate limit.
    const status = response.status === 403 && remaining !== "0" ? 401 : response.status;
    return {
      status,
      etag: response.headers.get("etag") ?? undefined,
      body: response.status >= 200 && response.status < 300 ? await response.json() : undefined,
      resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined,
    };
  };

export const makeTriggers = (options: TriggerOptions = {}) =>
  Effect.gen(function* () {
    const projects = yield* AutomationProjects;
    const runner = yield* AutomationRunner;
    const store = yield* Effect.serviceOption(SessionStore);
    const credentials = yield* Effect.serviceOption(GitHubCredentials.GitHubCredentials);
    const now = options.now ?? Date.now;
    const api = options.api ?? githubApi;

    const read = <K extends keyof State>(key: K) =>
      (Option.isSome(store) ? store.value.kvGet(KEYS[key]) : Effect.succeed(undefined)).pipe(
        Effect.map((raw): State[K] => {
          try {
            return raw === undefined ? ({} as State[K]) : (JSON.parse(raw) as State[K]);
          } catch {
            return {} as State[K];
          }
        }),
      );
    const state: State = { enabled: yield* read("enabled"), schedule: yield* read("schedule"), github: yield* read("github"), deliveries: yield* read("deliveries") };
    const save = (key: keyof State) => (Option.isSome(store) ? store.value.kvSet(KEYS[key], JSON.stringify(state[key])) : Effect.void);
    const problems = new Map<string, string>();
    const access = new Map<string, { readonly association: string; readonly at: number }>();
    const fetched = new Map<string, number>();
    /** How many times each automation was turned off or deleted since the runtime started. */
    const turnedOff = new Map<string, number>();
    const turnOff = (id: string) => turnedOff.set(id, (turnedOff.get(id) ?? 0) + 1);
    let lastPoll = 0;
    const tokenNow = Option.isSome(credentials)
      ? credentials.value.get("github.com").pipe(Effect.map((c) => Redacted.value(c.token)), Effect.option, Effect.map(Option.getOrUndefined))
      : Effect.succeed(undefined);

    /**
     * Deleted (forget) since tick or poll surveyed it: what they still bring back is kept for no one, so an automation
     * made again under its name starts clean. Every automation a trigger acts for was on when surveyed, so it has an entry.
     */
    const deleted = (id: string) => state.enabled[id] === undefined;

    const record = (id: string, delivery: DeliveryRecord) => {
      if (deleted(id)) return Effect.void;
      state.deliveries[id] = [delivery, ...(state.deliveries[id] ?? []).filter((d) => d.id !== delivery.id)].slice(0, MAX_DELIVERIES);
      return save("deliveries");
    };

    /** Each checkout's GitHub repository as git last named it: where its automations may still listen while git cannot say. */
    const lastRepo = new Map<string, string>();

    /**
     * Where the checkout's origin stands. Read each time, never kept: Publish adds origin to a checkout the runtime
     * already polls. Untranslated, so a folder in no repository reads as one whatever language the person's git speaks.
     */
    const originOf = (root: string): Effect.Effect<Origin> =>
      Effect.promise(() =>
        git(root, ["remote", "get-url", "origin"], { LC_ALL: "C" }).then(
          (url): Origin => {
            const repo = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url.trim()) ?? undefined;
            return repo === undefined ? { kind: "none" } : { kind: "github", repo };
          },
          (error: { readonly code?: unknown; readonly stderr?: string; readonly message?: string }): Origin => {
            // Exit 2 is git saying there is no origin.
            if (error.code === 2) return { kind: "none" };
            if (/not a git repository/i.test(error.stderr ?? "")) return { kind: "folder" };
            // A spawn that failed under load, or a checkout git will not read (dubious ownership): either way git said nothing about origin.
            const said = (error.stderr ?? "").split("\n").find((line) => line.trim() !== "") ?? error.message ?? "git did not run";
            return { kind: "unread", reason: said.trim().replace(/^(fatal|error): /, "") };
          },
        ),
      ).pipe(
        Effect.tap((origin) =>
          Effect.sync(() => {
            if (origin.kind === "github") lastRepo.set(root, origin.repo);
            else if (origin.kind !== "unread") lastRepo.delete(root);
          }),
        ),
      );

    /** A project's automations, and the default branch they were weighed against. */
    const survey = (projectId: string, root: string): Effect.Effect<{ readonly view: BranchView; readonly candidates: ReadonlyArray<Candidate> }> =>
      Effect.gen(function* () {
        const registry = yield* projects.registry;
        const working = yield* projects.sources(root);
        const workingCheck = checkSources({ sources: working, registry });
        const view: BranchView = yield* projects.branch(root);
        const branchCheck: ProjectCheck | undefined = view.sources === undefined ? undefined : checkSources({ sources: view.sources, registry });
        const out: Candidate[] = [];
        const names = new Map<string, LoadedAutomation>();
        for (const a of workingCheck.automations) names.set(`${a.scope}:${a.name}`, a);
        for (const a of branchCheck?.automations ?? []) if (a.scope === "project" && !names.has(`project:${a.name}`)) names.set(`project:${a.name}`, a);
        for (const automation of names.values()) {
          const { name, scope } = automation;
          const id = fileAutomationId(projectId, scope, name);
          const saved = state.enabled[id];
          // F-1: on only when the person turned it on or the app saved it, Me files included.
          const enabled = saved?.on ?? false;
          const fromBranch = scope === "project";
          const check = fromBranch ? branchCheck : workingCheck;
          const sources = fromBranch ? view.sources : working;
          const revision = check === undefined || sources === undefined ? undefined : revisionFrom({ sources, registry, check, name, scope, from: fromBranch ? "default_branch" : "working_tree" });
          const status = (problem?: string): TriggerStatus => ({ enabled, ...(problem ? { problem } : {}) });
          const off = (problem?: string) => out.push({ id, name, scope, live: false, status: status(problem), ...(revision ? { revision } : {}) });
          if (fromBranch && view.unreadable) {
            const next = state.schedule[id]?.next;
            const problem = enabled ? `Could not read ${view.branch?.name ?? "the default branch"} with git; Caveman tries again in a few seconds.` : undefined;
            out.push({ id, name, scope, live: false, unknown: true, status: { ...status(problem), ...(next !== undefined ? { nextRunAt: next } : {}) } });
            continue;
          }
          // A Project automation's triggers are the default branch's; the working tree's copy may differ.
          const on = (revision?.automation.file ?? automation.file).on;
          // A file for Caveman Cloud fires there, never here (CONTRACT §9); running it by hand still works.
          if (hostOf(revision?.automation.file ?? automation.file) === "cloud") {
            off("It runs on Cloud (host: cloud); send it there with caveman-runtime apply. Running it by hand here still works.");
            continue;
          }
          const triggered = on?.github !== undefined || on?.schedule !== undefined;
          if (!enabled || !triggered) {
            off();
            continue;
          }
          // Each reason is one sentence that says what to do (B9).
          if (fromBranch && view.branch === undefined) {
            off("Push this repo to GitHub so Caveman can read its default branch, or make it a Me automation.");
            continue;
          }
          const copy = fromBranch ? `${view.branch!.name}'s copy` : "The file";
          if (fromBranch && revision === undefined) {
            off(`Merge it to ${view.branch!.name} to start its triggers.`);
            continue;
          }
          if (fromBranch && view.workflow) {
            off("Its triggers run in GitHub Actions for this repo.");
            continue;
          }
          const errors = blockingErrors(check!, revision!.automation);
          if (errors.length > 0) {
            const first = errors[0]!;
            off(`${copy} has errors: ${first.path}:${first.line} ${first.message}`);
            continue;
          }
          if (saved?.authority === undefined) {
            // It did not load when turned on, or it was turned on before Me files were bound (F-1).
            off("Turn it on again to confirm what it may do.");
            continue;
          }
          if (saved.authority !== authorityOf(revision!)) {
            off(`Turn it on again: ${fromBranch ? copy : "the file"} changed what it may do.`);
            continue;
          }
          const problem = problems.get(id);
          const slot = state.schedule[id];
          const next = on?.schedule === undefined ? undefined : slot !== undefined && slot.key === JSON.stringify(on.schedule) ? slot.next : nextFire(on.schedule, now(), 0);
          out.push({ id, name, scope, revision: revision!, live: true, status: { enabled, ...(problem ? { problem } : {}), ...(next !== undefined ? { nextRunAt: next } : {}) } });
        }
        return { view, candidates: out };
      });
    const candidates = (projectId: string, root: string) => survey(projectId, root).pipe(Effect.map((s) => s.candidates));

    /** Some automation of the project is on, Project or Me: only then can a trigger of it fire, so only then is it read. */
    const anyOn = (projectId: string) => {
      const prefixes = [fileAutomationId(projectId, "project", ""), fileAutomationId(projectId, "me", "")];
      return Object.entries(state.enabled).some(([id, e]) => e.on && prefixes.some((prefix) => id.startsWith(prefix)));
    };

    /** Some Project automation of the project is on. */
    const projectOn = (projectId: string) => {
      const prefix = fileAutomationId(projectId, "project", "");
      return Object.entries(state.enabled).some(([id, e]) => e.on && id.startsWith(prefix));
    };

    /** Hands one trigger to the runner, and records what came of it. */
    const admit = (projectId: string, candidate: Candidate, trigger: TriggerEvent, by?: string) =>
      Effect.gen(function* () {
        const revision = candidate.revision!;
        // tick and poll picked the candidate before their awaits (a save, git, GitHub): turned off, deleted or bound to
        // another copy since, it starts nothing (§8.5, rule 9).
        const vouched = state.enabled[candidate.id];
        if (vouched?.on !== true || vouched.authority !== authorityOf(revision)) return;
        const offs = turnedOff.get(candidate.id);
        const base = deliveryBase(trigger, by);
        // Rule 3: untrusted text never meets a step with a checkout on This Mac.
        const exposed = Object.entries(revision.automation.file.steps).find(([, step]) => computerOf(step) !== "none");
        if (!trigger.trusted && exposed !== undefined) {
          return yield* record(candidate.id, {
            ...base,
            outcome: "refused",
            reason: "needs_isolation",
            message: `${trigger.subject} carries text from outside the repository, and step "${exposed[0]}" has a checkout on This Mac, which is not isolated; run it in CI or on a Caveman computer.`,
          });
        }
        const result = yield* runner.admit({ projectId, revision, trigger, apply: true });
        // Turned off while the runner admitted it, before the run was there for setEnabled or forget to cancel.
        if ("runId" in result && turnedOff.get(candidate.id) !== offs) yield* runner.cancel(result.runId, "policy_denied");
        yield* record(
          candidate.id,
          "runId" in result
            ? { ...base, outcome: "started", runId: result.runId }
            : { ...base, outcome: result.refused === "skipped_overlap" ? "skipped" : "refused", reason: result.refused, message: result.message },
        );
      });

    /** Some automation anywhere is on. */
    const someOn = () => Object.values(state.enabled).some((e) => e.on);

    const tick = Effect.gen(function* () {
      const at = now();
      if (!someOn()) return;
      for (const { projectId, root } of yield* projects.projects) {
        // Nothing on, nothing live: its files and git are not read every few seconds for nothing.
        if (!anyOn(projectId)) continue;
        for (const candidate of yield* candidates(projectId, root)) {
          // A tick that finds it not live keeps its slot: one failed read around a due time must not drop that fire or
          // restart an interval, and a default branch git cannot read is unknown, not off. Turning it off or on, or deleting it, clears the slot (setEnabled, forget).
          if (!candidate.live) continue;
          const schedule = candidate.revision?.automation.file.on?.schedule;
          if (schedule === undefined) {
            if (state.schedule[candidate.id] !== undefined) {
              delete state.schedule[candidate.id];
              yield* save("schedule");
            }
            continue;
          }
          const key = JSON.stringify(schedule);
          let slot = state.schedule[candidate.id];
          if (slot === undefined || slot.key !== key) {
            slot = { key, ...withNext(nextFire(schedule, at, 0)) };
            state.schedule[candidate.id] = slot;
            yield* save("schedule");
          }
          if (slot.next === undefined || slot.next > at) continue;
          const due = slot.next;
          // A wall-clock time missed while the runtime was closed waits for the next one, and does not count toward
          // count; an interval catches up once.
          const missed = isWallClock(schedule) && at - due > LATE_GRACE_MS;
          const runs = (slot.runs ?? 0) + (missed ? 0 : 1);
          state.schedule[candidate.id] = { key, ...withNext(nextFire(schedule, at, runs)), ...(runs > 0 ? { runs } : {}) };
          yield* save("schedule");
          if (missed) {
            // A once has no next time, so say it was missed instead of letting it vanish.
            if (schedule.once !== undefined) {
              const dueAt = new Date(due).toISOString();
              yield* record(candidate.id, {
                id: `schedule:${candidate.id}:${due}`,
                at: new Date(at).toISOString(),
                kind: "schedule",
                subject: `schedule:${candidate.name}`,
                outcome: "skipped",
                reason: "missed",
                message: `Missed: Caveman Code was closed or asleep at ${dueAt}, more than ${LATE_GRACE_MS / 60_000} minutes before it could start. Run it by hand to do it now.`,
              });
            }
            continue;
          }
          yield* admit(projectId, candidate, {
            kind: "schedule",
            subject: `schedule:${candidate.name}`,
            delivery: `schedule:${candidate.id}:${due}`,
            trusted: true,
            receivedAt: new Date(at).toISOString(),
          });
        }
      }
    });

    /** K9: a project with a Project automation turned on fetches its default branch every few minutes, quietly. */
    const fetchIfDue = (projectId: string, root: string) =>
      Effect.gen(function* () {
        if (!projectOn(projectId)) return;
        if (now() - (fetched.get(root) ?? 0) < FETCH_EVERY_MS) return;
        fetched.set(root, now());
        const branch = (yield* projects.branch(root)).branch;
        if (branch === undefined || !branch.ref.startsWith("origin/")) return;
        yield* Effect.promise(() => fetchDefaultBranch(root, branch.name));
      });

    const poll = Effect.gen(function* () {
      lastPoll = now();
      // Read once some automation listens on GitHub (the keychain, or gh): asked for nothing otherwise.
      let token: string | undefined;
      let tokenRead = false;
      // Nothing on anywhere and no cursor left to forget (A12): nothing to read.
      if (!someOn() && Object.keys(state.github).length === 0) return;
      // One poll per repository serves every project and automation that listens there.
      const watching = new Map<string, Array<{ readonly projectId: string; readonly branch: string; readonly candidate: Candidate }>>();
      // Repositories some automation that is on may listen to, though which events, or whether at all, is unknown just now.
      const held = new Set<string>();
      for (const { projectId, root } of yield* projects.projects) {
        // With nothing on it neither listens nor waits, so its repository is neither polled nor held.
        if (!anyOn(projectId)) continue;
        yield* fetchIfDue(projectId, root);
        const { view, candidates: all } = yield* survey(projectId, root);
        const listening = all.filter((c) => c.live && c.revision?.automation.file.on?.github !== undefined);
        const waiting = view.unreadable && projectOn(projectId);
        if (!waiting && listening.length === 0) continue;
        const origin = yield* originOf(root);
        const fail = (problem: string) => listening.forEach((c) => problems.set(c.id, problem));
        if (origin.kind === "unread") {
          // Its automations may still listen where origin was last seen, so that repository waits as below. Only that
          // one: a checkout git has not read since the runtime started, such as one git refuses for its owner, holds
          // nothing, so it never keeps another repository's cursor (A12).
          const last = lastRepo.get(root);
          if (last !== undefined) held.add(last);
          fail(`Could not read this repo's origin remote with git (${origin.reason}); Caveman tries again in a minute.`);
          continue;
        }
        if (waiting && origin.kind === "github") {
          // Polled for less than its Project automations want, the cursor would drop their place (A12), so the
          // repository waits, Me automations too, and nothing that arrives meanwhile is missed.
          held.add(origin.repo);
          fail(`Could not read ${view.branch?.name ?? "the default branch"} with git, so Caveman waits to poll GitHub until it can.`);
          continue;
        }
        if (listening.length === 0) continue;
        if (origin.kind === "folder") {
          fail("This folder is not a git repository; initialize git and publish it to GitHub to start its GitHub triggers.");
          continue;
        }
        if (origin.kind === "none") {
          fail("This repo has no GitHub origin remote.");
          continue;
        }
        if (!tokenRead) {
          token = yield* tokenNow;
          tokenRead = true;
        }
        if (token === undefined) {
          fail("Sign in to GitHub in Settings > Accounts.");
          continue;
        }
        const branch = view.branch?.name ?? "main";
        watching.set(origin.repo, [...(watching.get(origin.repo) ?? []), ...listening.map((candidate) => ({ projectId, branch, candidate }))]);
      }
      // A12: a repository nobody polls keeps no cursor, so whoever listens there next takes fresh bearings.
      const stale = Object.keys(state.github).filter((repo) => !watching.has(repo) && !held.has(repo));
      for (const repo of stale) delete state.github[repo];
      if (stale.length > 0) yield* save("github");
      for (const [repo, listening] of watching) {
        if (held.has(repo)) continue;
        const want = mergeWants(listening.map(({ candidate, branch }) => wantOf(candidate.revision!.automation.file.on!.github!, branch)));
        const polledAt = now();
        const result = yield* Effect.promise(() => pollRepo({ api: api(token!), repo, want, cursor: state.github[repo] ?? {}, now: polledAt, access }));
        state.github[repo] = result.cursor;
        yield* save("github");
        for (const { candidate } of listening) {
          if (result.problems.length > 0 && !deleted(candidate.id)) problems.set(candidate.id, result.problems[0]!);
          else problems.delete(candidate.id);
        }
        for (const delivery of result.deliveries) {
          for (const { projectId, branch, candidate } of listening) {
            const decision = route(candidate.revision!.automation.file.on!.github!, delivery, branch);
            if (decision.kind === "skip") continue;
            const trigger: TriggerEvent = {
              kind: "github",
              event: delivery.event,
              subject: delivery.subject,
              delivery: delivery.delivery,
              payload: decision.kind === "fire" ? decision.payload : undefined,
              ...(delivery.title ? { subjectTitle: delivery.title } : {}),
              ...(delivery.payload.url ? { subjectUrl: delivery.payload.url } : {}),
              trusted: decision.kind === "fire" && decision.trusted,
              receivedAt: delivery.receivedAt,
            };
            if (decision.kind === "refuse") {
              yield* record(candidate.id, { ...deliveryBase(trigger, byOf(delivery)), outcome: "refused", reason: decision.reason, message: decision.message });
              continue;
            }
            yield* admit(projectId, candidate, trigger, byOf(delivery));
          }
        }
        // Events skipped for good leave no other trace: each automation that listens for them keeps it with what arrived,
        // newest, where the next clean poll does not clear it as it does a problem.
        for (const { branch, candidate } of listening) {
          const wants = wantOf(candidate.revision!.automation.file.on!.github!, branch);
          for (const { want: list, message } of result.skipped) {
            if (!wants[list]) continue;
            const at = new Date(polledAt).toISOString();
            yield* record(candidate.id, { id: `gh:${repo}:skipped:${list}:${at}`, at, kind: "github", subject: `github:${repo}`, outcome: "skipped", message });
          }
        }
      }
    });

    const manualTrigger: AutomationTriggers["Service"]["manualTrigger"] = ({ root, automation, subject }) =>
      Effect.gen(function* () {
        const receivedAt = new Date(now()).toISOString();
        if (subject === undefined) return { kind: "manual", subject: `manual:${ulid(now())}`, trusted: true, receivedAt } satisfies TriggerEvent;
        const refuse = (reason: "invalid_params" | "invalid_state", message: string) => Effect.fail(new AutomationFilesError({ reason, message }));
        const match = /^github:([\w.-]+\/[\w.-]+)#(\d+)$/.exec(subject.trim());
        if (match === null) return yield* refuse("invalid_params", `${subject} is not an issue or pull request; name one as github:<owner>/<repo>#<number>.`);
        const origin = yield* originOf(root);
        if (origin.kind === "unread") return yield* refuse("invalid_state", `Could not read this repo's origin remote with git (${origin.reason}); try again.`);
        if (origin.kind === "folder") return yield* refuse("invalid_state", "This folder is not a git repository, so a run cannot be about a GitHub issue or pull request.");
        if (origin.kind === "none") return yield* refuse("invalid_state", "This repo has no GitHub origin remote, so a run cannot be about one of its issues.");
        const repo = origin.repo;
        if (match[1]!.toLowerCase() !== repo.toLowerCase()) return yield* refuse("invalid_params", `${subject} is not in this repo; name an issue or pull request of ${repo}.`);
        const token = yield* tokenNow;
        if (token === undefined) return yield* refuse("invalid_state", "Sign in to GitHub in Settings > Accounts, so Caveman can read the issue.");
        const number = Number(match[2]);
        const found = yield* Effect.promise(() => subjectPayload(api(token), repo, number));
        if ("problem" in found) return yield* refuse("invalid_state", found.problem);
        const takes = subjectKindOf(automation.file);
        if (takes === "issue" && found.kind === "pull_request") return yield* refuse("invalid_params", `#${number} is a pull request; ${automation.name} runs on issues.`);
        if (takes === "pull_request" && found.kind === "issue") return yield* refuse("invalid_params", `#${number} is an issue; ${automation.name} runs on pull requests.`);
        return {
          kind: "manual",
          subject: `github:${repo}#${number}`,
          payload: found.payload,
          ...(found.title ? { subjectTitle: found.title } : {}),
          ...(found.url ? { subjectUrl: found.url } : {}),
          trusted: true,
          receivedAt,
        } satisfies TriggerEvent;
      });

    /** SEMANTICS §8.3, §8.5: an automation turned off or deleted cancels every run it still has going. */
    const cancelRuns = (id: string) =>
      runner.runs({ automationId: id, live: true }).pipe(
        Effect.flatMap((going) => Effect.forEach(going, (run) => runner.cancel(run.run_id, "policy_denied"), { concurrency: "unbounded", discard: true })),
      );

    const service: AutomationTriggers["Service"] = {
      candidates,
      setEnabled: ({ projectId, root, name, scope, enabled }) =>
        Effect.gen(function* () {
          const id = fileAutomationId(projectId, scope, name);
          const wasOn = state.enabled[id]?.on === true;
          // The copy the person sees and turns on: the working tree's; when a Project file does not load there, the default branch's.
          const here = enabled ? (yield* projects.revisionAt(root, name, scope, "working_tree")).revision : undefined;
          const revision = here ?? (enabled && scope === "project" ? (yield* projects.revisionAt(root, name, scope, "default_branch")).revision : undefined);
          state.enabled[id] = { on: enabled, ...(revision !== undefined ? { authority: authorityOf(revision) } : {}) };
          if (!enabled) turnOff(id);
          delete state.schedule[id];
          problems.delete(id);
          yield* save("enabled");
          yield* save("schedule");
          // Only turning it off: a run started by hand while it was off is the person's, and keeps going.
          if (wasOn && !enabled) yield* cancelRuns(id);
        }),
      saved: ({ projectId, root, name }) =>
        Effect.gen(function* () {
          const id = fileAutomationId(projectId, "me", name);
          if (state.enabled[id]?.on === false) return;
          yield* projects.invalidate(root);
          const { revision } = yield* projects.revisionAt(root, name, "me", "working_tree");
          state.enabled[id] = { on: true, ...(revision !== undefined ? { authority: authorityOf(revision) } : {}) };
          yield* save("enabled");
        }),
      forget: (id) =>
        Effect.gen(function* () {
          delete state.enabled[id];
          turnOff(id);
          delete state.schedule[id];
          delete state.deliveries[id];
          problems.delete(id);
          yield* Effect.all([save("enabled"), save("schedule"), save("deliveries")]);
          yield* cancelRuns(id);
        }),
      manualTrigger,
      deliveries: (id) => Effect.sync(() => state.deliveries[id] ?? []),
      tick,
      nextScheduled: Effect.sync(() => {
        const next = Object.values(state.schedule).flatMap((slot) => (slot.next === undefined ? [] : [slot.next]));
        return next.length === 0 ? undefined : Math.min(...next);
      }),
      poll,
    };

    const scheduler = yield* Effect.serviceOption(Scheduler);
    if (Option.isSome(scheduler)) {
      yield* scheduler.value.register("automations", tick);
      yield* scheduler.value.register("automations-github", Effect.suspend(() => (now() - lastPoll >= POLL_EVERY_MS ? poll : Effect.void)));
    }
    return service;
  });

/**
 * A checkout's origin as git tells it: its GitHub repository; none (no origin, or one not on GitHub); a folder in no
 * git repository; or unread, git's reason why it could not say.
 */
type Origin =
  | { readonly kind: "github"; readonly repo: string }
  | { readonly kind: "none" }
  | { readonly kind: "folder" }
  | { readonly kind: "unread"; readonly reason: string };

const withNext = (next: number | undefined) => (next === undefined ? {} : { next });

/** What every delivery record of a trigger starts with (B5). */
const deliveryBase = (trigger: TriggerEvent, by?: string) => ({
  id: trigger.delivery ?? `${trigger.subject}:${trigger.receivedAt}`,
  at: trigger.receivedAt,
  kind: trigger.kind,
  subject: trigger.subject,
  ...(trigger.event ? { event: trigger.event } : {}),
  ...(trigger.subjectTitle ? { subjectTitle: trigger.subjectTitle } : {}),
  ...(by ? { by } : {}),
});

export const layer = Layer.effect(AutomationTriggers, makeTriggers());
