// `caveman-runtime automation check | explain | list | new | run | apply` and `caveman-runtime agent run`; `apply`,
// `check` and `explain` also stand at the top (`caveman-runtime apply`).
//
// check, explain, list and new work offline on the git root of the current directory: the automation
// package and the files, nothing else, so they answer in well under a second with no runtime. explain asks
// the running runtime instead when it knows this repository, so models show as they will resolve. run and
// agent run hand the work to the running runtime over the Session Protocol, as `caveman code attach` does.
// `--wait` follows a run to its end and prints what it did; it exits 1 when the run failed or a reviewer asked for
// changes. apply sends the repository's Cloud automations (host: cloud) to Caveman Cloud: with a code:run key
// straight to Cloud, else as the person signed in to the running Caveman Code; it prints how each one's authority
// changes. Exit codes: 0 ok, 1 problems (errors in the files, a refused or failed run, a refusal from Cloud), 2 usage
// (no such automation or template).
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";

import {
  explain,
  renderDiagnostics,
  renderExplain,
  templates,
  triggerWords,
  type Explanation,
  type LoadedAutomation,
  type ProjectCheck,
  type Scope,
  type Target,
} from "@caveman-app/automations";
import type { MethodName, Params, Result } from "@caveman-app/session-protocol";
import { connect } from "@caveman-app/session-protocol/client";
import type { AutomationRunRecord } from "@caveman-app/session-protocol/protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Argument, Command, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import { ApplyError, applyPlanOf, appliedFrom, renderApplied, renderHookSecrets } from "../automations/apply.ts";
import { offlineEnv } from "../automations/env.ts";
import { cloudFailure, cloudOrigin } from "../cloudLink/identity.ts";
import { AutomationFilesError, checkSources, createFromTemplate, defaultBranchOf, git, gitRoot, readBranch, readWorkingTree, registryAgents } from "../automations/files.ts";
import { RUNTIME_VERSION } from "../runtimeVersion.ts";
import { codeHome, liveRuntime } from "./code.ts";

const EXIT = { ok: 0, problems: 1, usage: 2 } as const;

/** Thrown to end a command with a message and an exit code. */
class Stop extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Runs a command body; a Stop prints its message (to stderr unless it is a plain answer) and sets the exit code. */
const command = (body: () => Promise<number | void>) =>
  Effect.promise(async () => {
    try {
      process.exitCode = (await body()) ?? EXIT.ok;
    } catch (error) {
      if (error instanceof Stop) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = error.code;
      } else if (error instanceof AutomationFilesError) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = error.reason === "not_found" ? EXIT.usage : EXIT.problems;
      } else throw error;
    }
  });
const say = (text: string) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);

/** The git root of the current directory, or a usage stop. */
async function root(): Promise<string> {
  const found = await gitRoot(process.cwd());
  if (found === undefined) throw new Stop(EXIT.usage, "Not inside a git repository; run this from the repository whose .caveman/ you mean.");
  return found;
}

async function load(rootDir: string, target: Target = "code"): Promise<ProjectCheck> {
  const [sources, registry] = await Promise.all([readWorkingTree(rootDir), registryAgents({ home: os.homedir() })]);
  return checkSources({ sources, registry, target });
}

/** One automation by name; both scopes having it needs --scope. */
function pick(check: ProjectCheck, name: string, scope: Scope | undefined): LoadedAutomation {
  const found = check.automations.filter((a) => a.name === name && (scope === undefined || a.scope === scope));
  if (found.length === 1) return found[0]!;
  if (found.length > 1) throw new Stop(EXIT.usage, `Both a Me and a Project automation are named ${name}; add --scope me or --scope project.`);
  if (check.diagnostics.some((d) => d.severity === "error" && d.path.endsWith(`/${name}.yaml`))) {
    throw new Stop(EXIT.problems, `${name} has errors and does not load:\n\n${renderDiagnostics(check.diagnostics.filter((d) => d.path.endsWith(`/${name}.yaml`)))}`);
  }
  const broken = [...new Set(check.diagnostics.filter((d) => d.severity === "error" && /^\.caveman\/(local\/)?automations\/[^/]+\.yaml$/.test(d.path)).map((d) => d.path.replace(/^.*\//, "").slice(0, -5)))];
  const names = [...check.automations.map((a) => a.name), ...broken.filter((b) => !check.automations.some((a) => a.name === b)).map((b) => `${b} (with errors)`)];
  throw new Stop(EXIT.usage, `No automation ${name}${names.length > 0 ? `; there is ${names.join(", ")}` : "; start one with caveman-runtime automation new <template>"}.`);
}

/** The running runtime, connected, with the project id of this repository; a stop that says how to start one otherwise. */
async function runtime(rootDir: string) {
  const live = await liveRuntime(codeHome());
  if (live === undefined) throw new Stop(EXIT.problems, "Caveman Code is not running; start it with `caveman code` (or open the app), then run this again.");
  const client = connect(live.url, live.token);
  const call = <M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> =>
    client.call(method, params).catch((error: { message?: string }) => {
      throw new Stop(EXIT.problems, error.message ?? String(error));
    });
  const real = fs.realpathSync(rootDir);
  const { projects } = await call("project.list", {});
  const project = projects.find((p) => p.path === real);
  return { call, close: () => client.close(), projectId: project?.id };
}

const scopeFlag = Flag.Literals("scope", ["me", "project"]).pipe(Flag.withDescription("Which file, when a Me and a Project automation share the name."), Flag.optional);
const jsonFlag = Flag.Boolean("json").pipe(Flag.withDescription("Print JSON."), Flag.withDefault(false));
const waitFlag = Flag.Boolean("wait").pipe(Flag.withDescription("Wait for the run to end and print what it did; exit 1 if it failed or a reviewer asked for changes."), Flag.withDefault(false));

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const POLL_MS = 2_000;

/** Asks for the run until it ends. Ctrl-C stops the waiting, never the run. */
async function waitForRun(call: <M extends MethodName>(method: M, params: Params<M>) => Promise<Result<M>>, runId: string): Promise<AutomationRunRecord> {
  for (;;) {
    const { run } = await call("automation.run_get", { run_id: runId });
    if (TERMINAL.has(run.status)) return run as AutomationRunRecord;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;

/**
 * What a finished run did, as a person reads it: each step with its decision and result, the branch and commit when
 * it changed files, and what it cost. ok: it succeeded and no step decided request_changes.
 */
export function runReport(run: AutomationRunRecord): { readonly text: string; readonly ok: boolean } {
  const lines = [`Run ${run.run} ${run.status}${run.reason ? ` (${run.reason.replace(/_/g, " ")})` : ""}.`];
  for (const step of run.steps) {
    const why = step.status !== "succeeded" && step.reason ? ` (${step.reason.replace(/_/g, " ")})` : "";
    lines.push(`\n${step.name}: ${step.status}${step.decision ? `, decided ${step.decision}` : ""}${why}`);
    if (step.summary) lines.push(...step.summary.trim().split("\n").map((l) => `  ${l}`));
  }
  const attempts = run.steps.flatMap((s) => s.attempts);
  if (attempts.some((a) => a.sha !== null)) lines.push(`\nChanges: branch ${run.workspace.branch} at ${(run.workspace.head ?? attempts.findLast((a) => a.sha !== null)!.sha!).slice(0, 12)}`);
  const tokens = attempts.reduce((n, a) => n + (a.cost === undefined ? 0 : a.cost.input + a.cost.output + a.cost.cache_read + a.cost.cache_write), 0);
  const plan = attempts.some((a) => a.cost?.billing === "plan");
  lines.push(
    `${attempts.some((a) => a.sha !== null) ? "" : "\n"}Cost: ${usd(run.budget.spent_usd)} ${run.budget.label}${run.budget.limit_usd !== null ? ` of a ${usd(run.budget.limit_usd)} budget` : ""}${tokens > 0 ? `, ${tokens.toLocaleString("en-US")} tokens` : ""}${plan ? "; a plan login has no per-token price" : ""}.`,
  );
  return { text: lines.join("\n"), ok: run.status === "succeeded" && !run.steps.some((s) => s.decision === "request_changes") };
}

/** Prints a started run: its record (--json), what it did once it ends (--wait), or how to follow it. */
async function follow(
  live: Awaited<ReturnType<typeof runtime>>,
  runId: string,
  options: { readonly wait: boolean; readonly json: boolean; readonly started: string },
): Promise<number> {
  if (!options.wait) {
    if (options.json) say(JSON.stringify((await live.call("automation.run_get", { run_id: runId })).run, null, 2));
    else say(options.started);
    return EXIT.ok;
  }
  if (!options.json) process.stderr.write(`Waiting for run ${runId} to end; Ctrl-C stops waiting, not the run.\n`);
  const run = await waitForRun(live.call, runId);
  const report = runReport(run);
  say(options.json ? JSON.stringify(run, null, 2) : report.text);
  return report.ok ? EXIT.ok : EXIT.problems;
}

/** The issue or pull request a run is about: --subject as given, or --issue / --pr on this repo's GitHub origin. */
async function subjectOf(rootDir: string, input: { readonly subject: Option.Option<string>; readonly issue: Option.Option<number>; readonly pr: Option.Option<number> }): Promise<string | undefined> {
  const given = [Option.isSome(input.subject), Option.isSome(input.issue), Option.isSome(input.pr)].filter(Boolean);
  if (given.length > 1) throw new Stop(EXIT.usage, "Name one subject: --subject, --issue or --pr.");
  if (Option.isSome(input.subject)) return input.subject.value;
  const number = Option.isSome(input.issue) ? input.issue.value : Option.isSome(input.pr) ? input.pr.value : undefined;
  if (number === undefined) return undefined;
  const url = await git(rootDir, ["remote", "get-url", "origin"]).then((u) => u.trim(), () => "");
  // Loaded only here, so check and explain stay quick.
  const { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } = await import("@caveman-app/shared/git");
  const repo = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url);
  if (!repo) throw new Stop(EXIT.usage, "This repo has no GitHub origin remote; pass --subject github:<owner>/<repo>#<number>.");
  return `github:${repo}#${number}`;
}

const checkCommand = Command.make("check", {
  target: Flag.Literals("target", ["code", "ci", "cloud"]).pipe(Flag.withDescription("Where it will run: code (Caveman Code on This Mac), ci or cloud."), Flag.withDefault("code" as Target)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Check every automation and agent file in .caveman/. Exits 1 when there are errors."),
  Command.withHandler(({ target, json }) =>
    command(async () => {
      const check = await load(await root(), target);
      const errors = check.diagnostics.filter((d) => d.severity === "error").length;
      if (json) say(JSON.stringify({ diagnostics: check.diagnostics, automations: check.automations.map((a) => ({ name: a.name, scope: a.scope, path: a.path })) }, null, 2));
      else if (check.diagnostics.length > 0) say(renderDiagnostics(check.diagnostics));
      else {
        const own = check.agents.filter((a) => a.path?.startsWith(".caveman/agents/")).length;
        say(`No problems: ${check.automations.length} automation${check.automations.length === 1 ? "" : "s"}${own > 0 ? ` and ${own} agent${own === 1 ? "" : "s"}` : ""} load clean.`);
      }
      return errors > 0 ? EXIT.problems : EXIT.ok;
    }),
  ),
);

const explainCommand = Command.make("explain", {
  name: Argument.String("name").pipe(Argument.withDescription("The automation's file name, without .yaml.")),
  step: Argument.String("step").pipe(Argument.withDescription("Explain only this step."), Argument.optional),
  scope: scopeFlag,
  levers: Flag.Boolean("levers").pipe(Flag.withDescription("List each Caveman harness lever under its one row."), Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Say what will actually happen when an automation runs here: every resolved value and where it comes from."),
  Command.withHandler(({ name, step, scope, levers, json }) =>
    command(async () => {
      const rootDir = await root();
      const check = await load(rootDir);
      const automation = pick(check, name, Option.getOrUndefined(scope));
      const stepName = Option.getOrUndefined(step);
      if (stepName !== undefined && automation.file.steps[stepName] === undefined) {
        throw new Stop(EXIT.usage, `${name} has no step ${stepName}; its steps are ${Object.keys(automation.file.steps).join(", ")}.`);
      }
      // The running runtime knows the engines and the models each class resolves to; offline, classes stay classes.
      let explanation: Explanation | undefined;
      const live = await liveRuntime(codeHome()).catch(() => undefined);
      if (live !== undefined) {
        const client = connect(live.url, live.token);
        try {
          const { projects } = await client.call("project.list", {});
          const project = projects.find((p) => p.path === fs.realpathSync(rootDir));
          if (project !== undefined) {
            explanation = (await client.call("automation.explain", { project_id: project.id, name, scope: automation.scope, ...(stepName ? { step: stepName } : {}) })).explanation as Explanation;
          }
        } catch {
          explanation = undefined;
        } finally {
          client.close();
        }
      }
      const offline = explanation === undefined;
      if (offline) {
        const branch = await defaultBranchOf(rootDir);
        const workflow = branch === undefined ? false : (await readBranch(rootDir, branch.ref)).workflow;
        explanation = explain({ automation, agents: check.agents, env: offlineEnv(workflow ? "github-actions" : "code"), ...(stepName ? { step: stepName } : {}) });
      }
      if (json) say(JSON.stringify(explanation, null, 2));
      else say(`${renderExplain(explanation!, { levers })}${offline ? "\n\nCaveman Code is not running, so models show as classes; start it with `caveman code` to see the model each one resolves to." : ""}`);
      return EXIT.ok;
    }),
  ),
);

const listCommand = Command.make("list", { json: jsonFlag }).pipe(
  Command.withDescription("List this repository's automations: Project (.caveman/automations/) and Me (.caveman/local/automations/)."),
  Command.withHandler(({ json }) =>
    command(async () => {
      const check = await load(await root());
      const rows = check.automations.map((a) => ({
        name: a.name,
        scope: a.scope,
        path: a.path,
        description: a.file.description,
        triggers: triggerWords(a.file),
        steps: Object.keys(a.file.steps),
        problems: check.diagnostics.filter((d) => d.path === a.path).length,
      }));
      const broken = [...new Set(check.diagnostics.filter((d) => d.severity === "error" && d.path.endsWith(".yaml") && !check.automations.some((a) => a.path === d.path)).map((d) => d.path))];
      if (json) {
        say(JSON.stringify({ automations: rows, not_loaded: broken }, null, 2));
        return EXIT.ok;
      }
      if (rows.length === 0 && broken.length === 0) {
        say("No automations here yet. Start one with: caveman-runtime automation new <template> (run it without a template for the list).");
        return EXIT.ok;
      }
      const width = Math.max(...rows.map((r) => r.name.length), 4);
      for (const r of rows) {
        say(`${r.name.padEnd(width)}  ${r.scope === "me" ? "Me     " : "Project"}  ${r.triggers.join(" · ")}${r.problems > 0 ? `  (${r.problems} problem${r.problems === 1 ? "" : "s"})` : ""}`);
        if (r.description) say(`${" ".repeat(width)}  ${r.description}`);
      }
      if (broken.length > 0) say(`\nNot loaded, with errors: ${broken.join(", ")}. Run caveman-runtime automation check.`);
      return EXIT.ok;
    }),
  ),
);

const newCommand = Command.make("new", {
  template: Argument.String("template").pipe(Argument.withDescription("A template id; leave it out for the list."), Argument.optional),
  me: Flag.Boolean("me").pipe(Flag.withDescription("Yours only: .caveman/local/automations/, ignored by git, on once you turn it on in Caveman Code."), Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Write a template's automation and agent files into this repository. Nothing is committed."),
  Command.withHandler(({ template, me }) =>
    command(async () => {
      const id = Option.getOrUndefined(template);
      const found = templates.find((t) => t.id === id);
      if (found === undefined) {
        const width = Math.max(...templates.map((t) => t.id.length));
        const list = templates.map((t) => `  ${t.id.padEnd(width)}  ${t.summary}`).join("\n");
        if (id === undefined) {
          say(`Templates:\n${list}\n\nWrite one with: caveman-runtime automation new <template> [--me]`);
          return EXIT.ok;
        }
        throw new Stop(EXIT.usage, `No template ${id}. Templates:\n${list}`);
      }
      const rootDir = await root();
      const created = await createFromTemplate(rootDir, found, me ? "me" : "project");
      for (const file of created.written) say(`wrote ${file}`);
      for (const { from, to } of created.renamed) say(`${from} was taken by a different file, so this one is ${to}`);
      if (created.written.length === 0) say(`${created.path} is already there, unchanged.`);
      const check = await load(rootDir);
      const mine = check.diagnostics.filter((d) => d.path === created.path || created.written.includes(d.path));
      if (mine.length > 0) say(`\n${renderDiagnostics(mine)}`);
      say(
        me
          ? `\nIt is yours and ignored by git. Its triggers start once you turn it on in Caveman Code > Automations. See what it will do: caveman-runtime automation explain ${created.name}`
          : `\nNext: caveman-runtime automation explain ${created.name}, then commit and open a pull request. Its triggers start once it merges and you turn it on in Caveman Code.`,
      );
      return mine.some((d) => d.severity === "error") ? EXIT.problems : EXIT.ok;
    }),
  ),
);

const runCommand = Command.make("run", {
  name: Argument.String("name").pipe(Argument.withDescription("The automation's file name, without .yaml.")),
  input: Flag.KeyValuePair("input").pipe(Flag.withDescription("A value for one of its inputs, as name=value; repeat for more."), Flag.optional),
  subject: Flag.String("subject").pipe(Flag.withDescription("What the run is about, as github:<owner>/<repo>#<number> in this repo."), Flag.optional),
  issue: Flag.Int("issue").pipe(Flag.withDescription("Run it on this issue of this repo."), Flag.optional),
  pr: Flag.Int("pr").pipe(Flag.withDescription("Run it on this pull request of this repo."), Flag.optional),
  apply: Flag.Boolean("apply").pipe(Flag.withDescription("Write its outputs (a comment, a pull request) when it ends; without it they wait for you."), Flag.withDefault(false)),
  scope: scopeFlag,
  wait: waitFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Run an automation now, in the running Caveman Code, from the files as they are."),
  Command.withHandler(({ name, input, subject, issue, pr, apply, scope, wait, json }) =>
    command(async () => {
      const rootDir = await root();
      const automation = pick(await load(rootDir), name, Option.getOrUndefined(scope));
      const about = await subjectOf(rootDir, { subject, issue, pr });
      const live = await runtime(rootDir);
      try {
        if (live.projectId === undefined) throw new Stop(EXIT.problems, "This repository is not a project in Caveman Code; add it there (Add project), then run this again.");
        const result = await live.call("automation.run", {
          request_id: randomUUID(),
          id: `file:${live.projectId}:${automation.scope}:${automation.name}`,
          ...(Option.isSome(input) ? { inputs: input.value } : {}),
          ...(about !== undefined ? { subject: about } : {}),
          apply,
        });
        const runId = result.run_id ?? "";
        // Only an automation with outputs has anything to apply.
        const outputs = Object.keys(automation.file.outputs ?? {}).length > 0;
        const waiting = outputs ? (apply ? " Its outputs are written when it ends." : " Its outputs wait for you to apply them from the run.") : "";
        return await follow(live, runId, { wait, json, started: `Started run ${runId} of ${name}${about ? ` on ${about}` : ""}.${waiting} Follow it in Caveman Code > Automations, or run this with --wait.` });
      } finally {
        live.close();
      }
    }),
  ),
);

/** Where `apply` sends with a key: the flag, else CAVEMAN_CLOUD_URL, else hosted Caveman Cloud. */
const HOSTED_CLOUD = "https://app.caveman.so";

export const applyCommand = Command.make("apply", {
  key: Flag.String("key").pipe(
    Flag.withDescription("A code:run key (cave_live_...). Else CAVEMAN_API_KEY; else the person signed in to the running Caveman Code."),
    Flag.optional,
  ),
  cloudUrl: Flag.String("cloud-url").pipe(Flag.withDescription("The Caveman server's URL, with a key. Else CAVEMAN_CLOUD_URL, else https://app.caveman.so."), Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Send this repository's Cloud automations (host: cloud) and the agents they name to Cloud, and print how each one changes what it may do."),
  Command.withHandler(({ key, cloudUrl, json }) =>
    command(async () => {
      const rootDir = await root();
      const apiKey = Option.getOrUndefined(key) ?? (process.env.CAVEMAN_API_KEY || undefined);
      if (apiKey !== undefined) {
        const plan = await applyPlanOf(rootDir, await registryAgents({ home: os.homedir() })).catch((error: unknown) => {
          throw error instanceof ApplyError ? new Stop(error.reason === "no_repo" ? EXIT.usage : EXIT.problems, error.message) : error;
        });
        let origin: string;
        try {
          origin = cloudOrigin(Option.getOrUndefined(cloudUrl) ?? (process.env.CAVEMAN_CLOUD_URL || HOSTED_CLOUD));
        } catch (error) {
          throw new Stop(EXIT.usage, `The Cloud URL is not usable: ${(error as Error).message}.`);
        }
        const response = await fetch(`${origin}/api/v1/code/automations/apply`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(plan.body),
          signal: AbortSignal.timeout(30_000),
        }).catch((error: unknown) => {
          throw new Stop(EXIT.problems, `Could not reach the Caveman server at ${origin}: ${(error as Error).message}`);
        });
        if (!response.ok) throw new Stop(EXIT.problems, `Caveman refused the files: ${(await cloudFailure(response)).message}`);
        const automations = appliedFrom(await response.json());
        if (json) say(JSON.stringify({ repo: plan.body.repo, commit_sha: plan.body.commit_sha, automations, skipped: plan.skipped }, null, 2));
        else say(renderApplied({ repo: plan.body.repo, automations, skipped: plan.skipped, origin, secrets: true }));
        return EXIT.ok;
      }
      // No key: the running Caveman Code sends them as the person signed in there.
      const live = await liveRuntime(codeHome()).catch(() => undefined);
      if (live === undefined) {
        throw new Stop(EXIT.problems, "Give a code:run key (--key, or CAVEMAN_API_KEY), or start Caveman Code signed in to Caveman (`caveman code`), then apply again.");
      }
      const client = connect(live.url, live.token);
      try {
        const out = await client.call("automation.apply", { request_id: randomUUID(), repo_root: fs.realpathSync(rootDir) });
        if (json) say(JSON.stringify({ repo: out.repo, commit_sha: out.commit_sha, automations: out.automations, skipped: out.skipped }, null, 2));
        else {
          // The text never holds a webhook's one-time secret; this terminal shows it, this once.
          const secrets = renderHookSecrets(out.automations);
          say(secrets === undefined ? out.text : `${out.text}\n\n${secrets}`);
        }
        return EXIT.ok;
      } catch (error) {
        const data = (error as { error?: { message?: string; data?: { reason?: string } } }).error;
        throw new Stop(EXIT.problems, data?.message ?? (error as Error).message);
      } finally {
        client.close();
      }
    }),
  ),
);

export { checkCommand, explainCommand };

export const automationCommand = Command.make("automation").pipe(
  Command.withDescription("Automation files in .caveman/: check, explain, list, new, run."),
  Command.withSubcommands([checkCommand, explainCommand, listCommand, newCommand, runCommand, applyCommand]),
);

const agentRunCommand = Command.make("run", {
  agent: Argument.String("agent").pipe(Argument.withDescription("An agent's name: .caveman/agents/<name>.md, .claude/agents, ~/.caveman/agents, or a built-in.")),
  task: Argument.String("task").pipe(Argument.withDescription("What it should do.")),
  model: Flag.String("model").pipe(Flag.withDescription("A class (fast, base, frontier), auto, or a model."), Flag.optional),
  computer: Flag.Literals("computer", ["none", "readonly", "full"]).pipe(Flag.withDescription("none, readonly (a copy, thrown away) or full (a worktree on a branch)."), Flag.optional),
  write: Flag.Boolean("write").pipe(Flag.withDescription("Let it change files, on a branch of its own (--computer full)."), Flag.withDefault(false)),
  readonly: Flag.Boolean("readonly").pipe(Flag.withDescription("Give it a copy whose changes are thrown away (--computer readonly)."), Flag.withDefault(false)),
  wait: waitFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Run one agent on a task, as a one-step run in the running Caveman Code."),
  Command.withHandler(({ agent, task, model, computer, write, readonly, wait, json }) =>
    command(async () => {
      if ([write, readonly, Option.isSome(computer)].filter(Boolean).length > 1) throw new Stop(EXIT.usage, "Pick one of --write, --readonly and --computer.");
      const access = write ? "full" : readonly ? "readonly" : Option.getOrUndefined(computer);
      const rootDir = await root();
      const live = await runtime(rootDir);
      try {
        if (live.projectId === undefined) throw new Stop(EXIT.problems, "This repository is not a project in Caveman Code; add it there (Add project), then run this again.");
        const { run_id } = await live.call("agent.run", {
          request_id: randomUUID(),
          project_id: live.projectId,
          agent,
          task,
          ...(Option.isSome(model) ? { model: model.value } : {}),
          ...(access !== undefined ? { computer: access } : {}),
        });
        // The Automations page does not list agent runs yet: --wait is how to see what it did.
        return await follow(live, run_id, { wait, json, started: `Started run ${run_id}: ${agent} on "${task}". Run this with --wait to see what it did.` });
      } finally {
        live.close();
      }
    }),
  ),
);

export const agentCommand = Command.make("agent").pipe(Command.withDescription("Agents as commands: run one on a task."), Command.withSubcommands([agentRunCommand]));

/**
 * `caveman-runtime automation ...` and `agent ...` from bin.ts, before the server's module graph loads (seconds):
 * the same commands binCli.ts registers, in a CLI of just these two.
 */
export function runAutomationCli(): void {
  const cli = Command.make("caveman-runtime").pipe(Command.withSubcommands([automationCommand, agentCommand, applyCommand, checkCommand, explainCommand]));
  Command.run(cli, { version: RUNTIME_VERSION }).pipe(
    // The help is printed already; a mistyped command or flag exits 2, asking for help exits 0.
    Effect.catch((error) => Effect.sync(() => void (process.exitCode = CliError.isCliError(error) && error._tag === "ShowHelp" && error.errors.length === 0 ? EXIT.ok : EXIT.usage))),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
