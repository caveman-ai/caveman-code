/**
 * `explain`: what will actually happen when an automation runs here. A pure
 * function of the loaded file, the agent registry and a snapshot of the
 * environment (engines, the class map, the harness levers, caps). Rows are
 * structured so the web draws them as a strip and the CLI prints them.
 *
 * @module explain
 */
import type { LoadedAutomation } from "./check.ts";
import {
  CLOUD_OUTPUTS,
  NEWS_DECISION,
  DEFAULT_ITERATIONS,
  RUN_DEADLINE_MS,
  approvalMsOf,
  budgetOf,
  computerOf,
  eventsOf,
  formatDuration,
  hostOf,
  isClaudeAlias,
  isGraph,
  isModelClass,
  listOf,
  outputSource,
  outsiderTriggers,
  rungsOf,
  stepKindOf,
  timeoutMsOf,
  writingSteps,
  calendarStep,
  type AutomationFile,
  type ScheduleTrigger,
  type GitHubEvent,
  type Step,
} from "./format.ts";
import { YamlSource, type AgentInfo } from "./parse.ts";

export interface EnvSnapshot {
  readonly host: "this-mac" | "laptop" | "ci" | "cloud";
  /** The runtime's new-chat default; a step's agent may name another. */
  readonly defaultEngine: string;
  /** `subscription`: signed in with a Claude or ChatGPT plan, where money caps cannot hold. */
  readonly engines: ReadonlyArray<{ readonly id: string; readonly available: boolean; readonly reason?: string; readonly subscription?: boolean }>;
  /** Per engine, what each class resolves to, and who set it. */
  readonly classes: Readonly<Record<string, { readonly fast?: string; readonly base?: string; readonly frontier?: string; readonly source: string }>>;
  /**
   * The harness levers per engine, with the evidence label shown verbatim. An entry with id `all` sums up its
   * engine's levers: explain shows that one row and keeps the others as detail rows (key `lever`).
   */
  readonly levers: ReadonlyArray<{ readonly engine: string; readonly id: string; readonly label: string; readonly on: boolean; readonly evidence: string }>;
  readonly triggerHome?: "code" | "github-actions";
  readonly budgetCap?: { readonly usd?: number; readonly source: string };
  /** What a run of a file with no `budget:` may spend: the runtime's default wallet. */
  readonly defaultBudgetUsd?: number;
  /** Trigger kinds this environment serves, e.g. ["manual", "schedule", "github"]. */
  readonly servedTriggers: ReadonlyArray<string>;
  /** No runtime to ask (the CLI with Caveman Code closed): classes stay classes, and say when they resolve. */
  readonly offline?: boolean;
}

/**
 * One fact. Keys repeat (`levers`, `outputs`, `checker`). Rows keyed `lever` are the detail behind the `levers`
 * row above them: the CLI prints them only with `{ levers: true }`, the page behind a disclosure.
 */
export interface ExplainRow {
  readonly key: string;
  readonly value: string;
  readonly detail?: string;
  /** Where the value comes from: a file and line, "built-in", "default", an environment setting. */
  readonly source?: string;
}

export interface ExplainStep {
  readonly name: string;
  /** `automations/<name>.yaml:<line>`. */
  readonly source: string;
  readonly rows: ReadonlyArray<ExplainRow>;
}

export interface Explanation {
  readonly automation: string;
  readonly scope: "me" | "project";
  readonly path: string;
  readonly header: ReadonlyArray<ExplainRow>;
  readonly steps: ReadonlyArray<ExplainStep>;
}

const EVENT_WORDS: Readonly<Record<GitHubEvent, string>> = {
  "issues.opened": "Issue opened",
  "issues.labeled": "Issue labelled",
  "pull_request.opened": "Pull request opened",
  "pull_request.synchronize": "Pull request updated",
  "issue_comment.created": "Comment",
  push: "Push to the default branch",
  "workflow_run.completed": "CI run finished",
  "pull_request.labeled": "Pull request labelled",
  "pull_request.closed": "Pull request closed",
  "check_suite.completed": "Checks finished",
};
const HOST_WORDS: Readonly<Record<EnvSnapshot["host"], string>> = { "this-mac": "This Mac", laptop: "this laptop", ci: "CI", cloud: "Cloud" };
const COMPUTER_WORDS = {
  full: (automation: string) => `full: a worktree on branch caveman/${automation}/<subject>`,
  readonly: () => "readonly: a copy at the run's commit; changes are discarded",
  code: () => "code: no checkout; runs JavaScript programs over its tools",
  none: () => "none: no checkout",
} as const;
const usd = (n: number) => `$${n.toFixed(2)}`;
const NEW_CHAT_DEFAULT = "the new-chat default";
const shortPath = (path: string) => path.replace(/^\.caveman\//, "");
/** The most steps a row names: in file order each step sees every one before it, and a file can hold thousands. */
const LISTED = 8;
/** `a, b, c`, or the first LISTED of `count` names and how many more. */
const someOf = (names: ReadonlyArray<string>, count = names.length) =>
  count > LISTED ? `${names.slice(0, LISTED).join(", ")} and ${count - LISTED} more` : names.join(", ");

/** Trigger words, as the list and detail page show them: "Issue labelled caveman". */
export function triggerWords(file: AutomationFile): string[] {
  const words: string[] = [];
  const github = file.on?.github;
  if (github !== undefined) {
    const labels = listOf(github.label);
    const branches = listOf(github.branches);
    const paths = listOf(github.paths);
    const events = eventsOf(github);
    const merged =
      events.length === 2 && events.includes("pull_request.opened") && events.includes("pull_request.synchronize")
        ? ["Pull request opened or updated"]
        : events.map((e) =>
            e === "issue_comment.created" && github.mention
              ? "Comment mentioning @caveman"
              : e === "pull_request.closed" && github.merged !== undefined
                ? github.merged ? "Pull request merged" : "Pull request closed without merging"
              : (e === "workflow_run.completed" || e === "check_suite.completed") && github.conclusion
                ? `${e === "check_suite.completed" ? "Checks" : "CI run"} ${github.conclusion === "failure" ? "failed" : github.conclusion === "timed_out" ? "timed out" : github.conclusion === "success" ? "passed" : "cancelled"}`
                : EVENT_WORDS[e],
          );
    const filters = [
      labels.length > 0 ? `${labels.join(" or ")}` : "",
      branches.length > 0 ? `on ${branches.join(", ")}` : events.includes("workflow_run.completed") ? "on the default branch" : "",
      pathWords(paths),
    ].filter(Boolean);
    words.push(...merged.map((m) => [m, ...filters].join(" ")));
  }
  const schedule = file.on?.schedule;
  if (schedule !== undefined) {
    const said = scheduleWords(schedule);
    if (said !== undefined) words.push(said);
  }
  if (file.on?.webhook !== undefined) words.push("Webhook");
  const slack = file.on?.slack;
  if (slack !== undefined) words.push(`Slack mention of @caveman${slack.channels !== undefined && slack.channels.length > 0 ? ` in ${slack.channels.join(", ")}` : ""}`);
  const tracker = (name: string, on: { readonly events?: ReadonlyArray<string>; readonly labels?: ReadonlyArray<string> }, scope: string | undefined) => {
    const events = on.events ?? [];
    const what = events.length === 0 ? `${name} issue` : events.map((e) => (e === "issue.created" ? `${name} issue created` : e === "issue.labeled" ? `${name} issue labelled` : `${name} comment mentioning @caveman`)).join(" or ");
    const labels = on.labels !== undefined && on.labels.length > 0 ? ` ${on.labels.join(" or ")}` : "";
    words.push(`${what}${labels}${scope !== undefined ? ` in ${scope}` : ""}`);
  };
  if (file.on?.linear !== undefined) tracker("Linear", file.on.linear, file.on.linear.team);
  if (file.on?.jira !== undefined) tracker("Jira", file.on.jira, file.on.jira.project);
  words.push("By hand");
  return words;
}

const ordinal = (day: number | "last") => {
  if (day === "last") return "last day";
  const tens = day % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  return `${day}${suffix}`;
};

/**
 * A schedule in words, as the list shows it: "Weekdays at 09:00 (Europe/Amsterdam)", "Every 6h", "Every 2 weeks on
 * Mon at 09:00 (UTC)", "Monthly on the 1st and last day at 09:00 (UTC)", "Once on 2026-11-09 at 09:00 (UTC)",
 * "Cron 0 9 * * 1-5 (UTC)", each with ", from <day>", ", until <day>" and ", <n> runs" when bounded.
 */
export function scheduleWords(schedule: ScheduleTrigger): string | undefined {
  const zone = schedule.timezone ? ` (${schedule.timezone})` : "";
  const step = calendarStep(schedule.every);
  let said: string | undefined;
  if (schedule.once !== undefined) said = `Once on ${schedule.once.slice(0, 10)} at ${schedule.once.slice(11)}${zone}`;
  else if (schedule.cron !== undefined) said = `Cron ${schedule.cron}${zone}`;
  else if (schedule.every !== undefined && step === undefined) said = `Every ${schedule.every}`;
  else if (schedule.at !== undefined && schedule.monthdays !== undefined) {
    const days = [...new Set(schedule.monthdays)].sort((a, b) => (a === "last" ? 32 : a) - (b === "last" ? 32 : b)).map(ordinal);
    said = `Monthly on the ${quoteWords(days)} at ${schedule.at}${zone}`;
  } else if (schedule.at !== undefined) {
    const days = schedule.weekdays;
    const named = days?.map((d) => d[0]!.toUpperCase() + d.slice(1)).join(", ");
    if (step?.unit === "day" && step.n > 1) said = `Every ${step.n} days at ${schedule.at}${zone}`;
    else if (step?.unit === "week" && step.n > 1) said = `Every ${step.n} weeks on ${named ?? "Mon"} at ${schedule.at}${zone}`;
    else {
      const when =
        days === undefined || days.length === 7
          ? "Every day"
          : days.length === 5 && ["mon", "tue", "wed", "thu", "fri"].every((d) => days.includes(d as never))
            ? "Weekdays"
            : named!;
      said = `${when} at ${schedule.at}${zone}`;
    }
  }
  if (said === undefined) return undefined;
  const bounds = [
    schedule.start !== undefined && schedule.once === undefined ? `from ${schedule.start}` : "",
    schedule.until !== undefined && schedule.once === undefined ? `until ${schedule.until}` : "",
    schedule.count !== undefined && schedule.once === undefined ? `${schedule.count} ${schedule.count === 1 ? "run" : "runs"}` : "",
  ].filter(Boolean);
  return bounds.length > 0 ? `${said}, ${bounds.join(", ")}` : said;
}

const quoteWords = (items: ReadonlyArray<string>) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** The kinds of trigger a file declares, manual always among them. */
export const triggerKinds = (file: AutomationFile): Array<"manual" | "schedule" | "github" | "webhook" | "slack" | "linear" | "jira"> => [
  "manual",
  ...(file.on?.schedule !== undefined ? (["schedule"] as const) : []),
  ...(file.on?.github !== undefined ? (["github"] as const) : []),
  ...(file.on?.webhook !== undefined ? (["webhook"] as const) : []),
  ...(file.on?.slack !== undefined ? (["slack"] as const) : []),
  ...(file.on?.linear !== undefined ? (["linear"] as const) : []),
  ...(file.on?.jira !== undefined ? (["jira"] as const) : []),
];

export function explain(input: {
  readonly automation: LoadedAutomation;
  readonly agents: ReadonlyArray<AgentInfo>;
  readonly step?: string;
  readonly env: EnvSnapshot;
}): Explanation {
  const { automation, env } = input;
  const { file } = automation;
  const agents = new Map(input.agents.map((a) => [a.name, a]));
  const yaml = new YamlSource(automation.path, automation.text);
  const line = (path: ReadonlyArray<PropertyKey>) => `line ${yaml.at(path, "key").line}`;
  const stepNames = Object.keys(file.steps);
  const graph = isGraph(file);
  const engineOf = (step: Step) => (step.agent === undefined ? undefined : agents.get(step.agent)?.engine) ?? env.defaultEngine;
  const engines = new Set(stepNames.map((n) => engineOf(file.steps[n]!)));
  const subscriptionEngines = new Set(env.engines.filter((e) => e.subscription).map((e) => e.id));
  const leverRows = (engine: string): ExplainRow[] => {
    let levers = env.levers.filter((l) => l.engine === engine);
    // Offline the default engine is not known: show the Caveman engine's levers, and say when they apply.
    const when = levers.length === 0 && env.offline ? "When it runs on the caveman engine." : undefined;
    if (when !== undefined) levers = env.levers.filter((l) => l.engine === "caveman");
    if (levers.length === 0) return [{ key: "levers", value: `none reported for ${engine}` }];
    const row = (l: EnvSnapshot["levers"][number], key: string): ExplainRow => ({ key, value: `${l.label}: ${l.on ? "on" : "off"}`, ...(l.evidence ? { source: l.evidence } : {}) });
    const all = levers.find((l) => l.id === "all");
    const rows = all === undefined ? levers.map((l) => row(l, "levers")) : [row(all, "levers"), ...levers.filter((l) => l !== all).map((l) => row(l, "lever"))];
    return when === undefined ? rows : [{ ...rows[0]!, detail: when }, ...rows.slice(1)];
  };

  // Header
  const header: ExplainRow[] = [];
  if (file.description !== undefined) header.push({ key: "description", value: file.description });
  header.push({ key: "triggers", value: triggerWords(file).join(" · ") });
  const triggered = triggerKinds(file).some((k) => k !== "manual");
  const cloud = hostOf(file) === "cloud";
  const home = automation.scope === "me" || env.triggerHome !== "github-actions" ? "Caveman Code" : "GitHub Actions";
  header.push({
    key: "runs on",
    value: cloud ? "Cloud" : HOST_WORDS[env.host],
    ...(cloud
      ? {
          detail: "Cloud fires its triggers and runs it on a Cloud computer once you send it there with caveman-runtime apply; a revision that widens what it may do waits for the owner's approval.",
          source: line(["host"]),
        }
      : triggered
        ? {
            detail:
              automation.scope === "me"
                ? "Triggers fire in Caveman Code once you turn it on, and stop if the file later changes what it may do."
                : `Triggers fire in ${home}${home === "Caveman Code" && file.on?.github ? ", which polls GitHub" : ""}, from the default branch's copy of this file.`,
          }
        : {}),
  });
  if (graph) {
    header.push({ key: "order", value: "a graph: each step starts once its needs are done, up to 4 at once", detail: "Steps that write the run's branch (computer: full) take turns." });
  }
  // SECURITY M1: who may write the text a run starts from, and what waits because of it.
  const outsiders = outsiderTriggers(file);
  if (outsiders.length > 0) {
    const writers = writingSteps(file);
    header.push({
      key: "untrusted",
      value: `text anyone may write can start it (${outsiders.join(", ")})`,
      detail:
        writers.length === 0
          ? "No step pushes, opens a pull request or posts anywhere but the thread or issue the text came from, so nothing waits for the owner."
          : `When a run's text comes from outside the trusted people, ${writers.length === 1 ? `step ${writers[0]} waits` : `steps ${writers.join(", ")} wait`} for the owner's approval before ${writers.length === 1 ? "it runs" : "they run"}. Replies in the thread or issue the text came from, and steps that only read, run as usual.`,
      source: line(outsiders[0]!.split(".")),
    });
  }

  const budget = budgetOf(file.budget);
  const cap = env.budgetCap?.usd;
  // A file with no budget runs on the runtime's default wallet (clamped by any cap), never unlimited.
  const fileUsd = budget?.usd ?? (budget === undefined ? env.defaultBudgetUsd : undefined);
  const effectiveUsd = fileUsd !== undefined && cap !== undefined ? Math.min(fileUsd, cap) : (fileUsd ?? cap);
  const anySubscription = [...engines].some((e) => subscriptionEngines.has(e));
  const limits = [budget?.tokens !== undefined ? `${budget.tokens.toLocaleString("en-US")} tokens` : "", budget?.turns !== undefined ? `${budget.turns} turns` : ""].filter(Boolean);
  const budgetNotes = [
    budget?.usd !== undefined && cap !== undefined && cap < budget.usd ? `The file says ${usd(budget.usd)}; ${env.budgetCap!.source} caps it at ${usd(cap)}.` : "",
    budget === undefined && env.defaultBudgetUsd !== undefined ? "The default for a file with no budget; add budget: to set your own." : "",
    budget === undefined && cap === undefined && env.defaultBudgetUsd === undefined ? "Add budget: $5 so a runaway run stops." : "",
    anySubscription ? "Steps on a subscription login get token and turn caps instead." : "",
  ].filter(Boolean);
  header.push({
    key: "budget",
    value:
      effectiveUsd !== undefined
        ? `${usd(effectiveUsd)} per run, all attempts${limits.length ? `, ${limits.join(", ")}` : ""}`
        : limits.length > 0
          ? `${limits.join(", ")} per run`
          : "no spending limit",
    ...(budgetNotes.length > 0 ? { detail: budgetNotes.join(" ") } : {}),
    source: file.budget !== undefined ? line(["budget"]) : env.defaultBudgetUsd !== undefined ? "default" : (env.budgetCap?.source ?? "not set"),
  });

  const tries = (s: Step) => ((s.retries ?? 0) + 1 + (s.outcome === undefined ? 0 : (s.outcome.max_iterations ?? DEFAULT_ITERATIONS) - 1)) * (s.parallel ?? 1);
  const attempts = stepNames.reduce((n, s) => n + (stepKindOf(file.steps[s]!) === "wait" ? 0 : tries(file.steps[s]!)), 0);
  const longest = Math.min(RUN_DEADLINE_MS, stepNames.reduce((ms, s) => ms + (stepKindOf(file.steps[s]!) === "wait" ? 0 : (tries(file.steps[s]!) / (file.steps[s]!.parallel ?? 1)) * timeoutMsOf(file.steps[s]!)), 0));
  header.push({
    key: "worst case",
    value: effectiveUsd !== undefined ? `${usd(effectiveUsd)} or ${formatDuration(longest)}, whichever comes first` : `${formatDuration(longest)}, with no spending limit`,
    detail: `At most ${attempts} attempt${attempts === 1 ? "" : "s"} across ${stepNames.length} step${stepNames.length === 1 ? "" : "s"}${longest === RUN_DEADLINE_MS ? "; the 2h run deadline stops the rest" : ""}.`,
  });
  // One engine for every step: its levers once, here.
  if (engines.size === 1) header.push(...leverRows([...engines][0]!));

  const ifRow = (conditions: Readonly<Record<string, string>>, at: ReadonlyArray<string>): ExplainRow => ({
    key: "runs if",
    value: Object.entries(conditions).map(([s, v]) => `${s} ${v === "failed" ? "failed" : `decided ${v}`}`).join(" and "),
    source: line([...at, "if"]),
  });
  /** What the runtime writes from this step's result when the run ends. */
  const outputRows = (name: string): ExplainRow[] => {
    const out: ExplainRow[] = [];
    const chief = file.outputs?.chief;
    if (chief !== undefined && chief.from === name) {
      out.push({
        key: "outputs",
        value: `chief: ${name}.summary`,
        detail: `The runtime hands it to ${chief.to === undefined ? "a Chief that works in the project" : `Chief ${chief.to} (while it is there; else a Chief that works in the project)`} when the run ends, if ${name} succeeded: its routine's row shows it, and a run that decided ${NEWS_DECISION} wakes the Chief with it as data. A manual run hands it over too.`,
        source: line(["outputs", "chief"]),
      });
    }
    for (const kind of ["github.comment", "github.pull_request", ...CLOUD_OUTPUTS] as const) {
      const value = file.outputs?.[kind];
      if (value === undefined || outputSource(value).step !== name) continue;
      const draft = kind === "github.pull_request" && typeof value !== "string" && "draft" in value && value.draft === true;
      const posted = (CLOUD_OUTPUTS as ReadonlyArray<string>).includes(kind);
      out.push({
        key: "outputs",
        value: kind === "github.pull_request" ? `github.pull_request${draft ? ", draft" : ""}` : `${kind}: ${name}.${outputSource(value).field}`,
        detail: posted
          ? `Cloud posts it when the run ends, if ${name} succeeded; agents hold no token for it.`
          : `The runtime writes it when the run ends, if ${name} succeeded${kind === "github.comment" ? ", editing its one comment" : ""}. A manual run waits for you to apply it.`,
        source: line(["outputs", kind]),
      });
    }
    return out;
  };

  // Steps
  const steps = stepNames
    .flatMap((name, index) => (input.step === undefined || name === input.step ? [{ name, index }] : []))
    .map(({ name, index }): ExplainStep => {
      const step = file.steps[name]!;
      const at = ["steps", name];
      const agent = step.agent === undefined ? undefined : agents.get(step.agent);
      const agentFile = agent === undefined ? undefined : agent.source === "builtin" ? "built-in" : agent.path !== undefined ? shortPath(agent.path) : agent.source;
      const rows: ExplainRow[] = [];
      const kind = stepKindOf(step);
      if (kind === "wait") {
        rows.push({ key: "waits", value: step.wait!, detail: "A timer the runtime keeps across restarts; the run's 2h deadline does not count it.", source: line([...at, "wait"]) });
      } else if (kind === "run") {
        rows.push({ key: "runs", value: step.run!, detail: "A command, with no model: your git, gh and ssh logins, no model or cloud keys; exit 0 succeeds.", source: line([...at, "run"]) });
      } else if (step.agent !== undefined) {
        const ignored = agent?.ignoredKeys ?? [];
        rows.push({
          key: "agent",
          value: step.agent,
          ...(agentFile === undefined
            ? { detail: "Not found; caveman check says why." }
            : { source: agentFile, ...(ignored.length > 0 ? { detail: `Caveman reads past its Claude Code keys: ${ignored.join(", ")}.` } : {}) }),
        });
      } else {
        const prompt = (step.prompt ?? "").replace(/\s+/g, " ").trim();
        rows.push({ key: "agent", value: "inline prompt", detail: `"${prompt.length > 70 ? `${prompt.slice(0, 67)}...` : prompt}"`, source: line([...at, "prompt"]) });
      }
      if (step.needs !== undefined) rows.push({ key: "needs", value: step.needs.length > 0 ? step.needs.join(", ") : "nothing; starts at once", source: line([...at, "needs"]) });
      if (step.if !== undefined && kind !== "agent") {
        rows.push({ key: "runs if", value: Object.entries(step.if).map(([s, v]) => `${s} ${v === "failed" ? "failed" : `decided ${v}`}`).join(" and "), source: line([...at, "if"]) });
      }
      if (step.approve !== undefined) {
        rows.push({
          key: "approve",
          value: `by ${step.approve.by === "owner" ? "the owner" : "a member who may write the repository"}, within ${formatDuration(approvalMsOf(step))}`,
          detail: "The run waits after this step succeeds; its outputs and the steps after it wait too.",
          source: line([...at, "approve"]),
        });
      }
      if (kind === "wait") return { name, source: `${shortPath(automation.path)}:${yaml.at(at, "key").line}`, rows };
      const decides = step.agent === undefined ? step.decides : agent?.decides;
      if (decides !== undefined && decides.length > 0) {
        rows.push({
          key: "decides",
          value: decides.join(" or "),
          ...(kind === "run" ? { detail: "The command's last line says which: decision: <value>." } : {}),
          source: step.agent === undefined ? line([...at, "decides"]) : agentFile!,
        });
      }
      const engine = engineOf(step);
      if (kind === "run") {
        const computer = computerOf(step);
        rows.push({ key: "computer", value: COMPUTER_WORDS[computer](automation.name), source: step.computer !== undefined ? line([...at, "computer"]) : "default" });
        rows.push({ key: "attempts", value: `${(step.retries ?? 0) + 1}, at most ${formatDuration(timeoutMsOf(step))} each`, source: step.retries !== undefined ? line([...at, "retries"]) : "default" });
        if (step.if !== undefined) rows.push(ifRow(step.if, at));
        rows.push(...outputRows(name));
        return { name, source: `${shortPath(automation.path)}:${yaml.at(at, "key").line}`, rows };
      }
      const engineInfo = env.engines.find((e) => e.id === engine);
      const engineSource = agent?.engine !== undefined ? agentFile! : NEW_CHAT_DEFAULT;
      rows.push({
        key: "engine",
        value: engine,
        ...(engineInfo !== undefined && !engineInfo.available
          ? { detail: `Not available here${engineInfo.reason ? `: ${engineInfo.reason}` : ""}.` }
          : engineInfo?.subscription
            ? { detail: "On your subscription login." }
            : {}),
        ...(engineSource === engine ? {} : { source: engineSource }),
      });

      const stepModel = step.model ?? agent?.model;
      rows.push(modelRow("model", stepModel, engine, env, step.model !== undefined ? line([...at, "model"]) : agent?.model !== undefined ? agentFile : undefined));
      const retries = step.retries ?? 0;
      if (typeof step.escalate === "string") {
        const row = modelRow("escalate", step.escalate, engine, env, line([...at, "escalate"]));
        rows.push({ ...row, detail: retries === 0 ? "No effect: retries is 0." : `Attempts 2${retries > 1 ? `-${retries + 1}` : ""}.${row.detail ? ` ${row.detail}` : ""}` });
      } else if (step.escalate !== undefined) {
        rungsOf(step.escalate).forEach((rung, i) => {
          const rungEngine = rung.engine ?? engine;
          const row = modelRow("escalate", rung.model ?? stepModel, rungEngine, env, i === 0 ? line([...at, "escalate"]) : undefined);
          const last = i === rungsOf(step.escalate).length - 1;
          const which = retries === 0 ? "No effect: retries is 0." : `Attempt ${i + 2}${last && retries + 1 > i + 2 ? ` and later` : ""}.`;
          rows.push({ ...row, value: `${rung.engine !== undefined ? `${rung.engine}, ` : ""}${row.value}`, detail: `${which}${row.detail ? ` ${row.detail}` : ""}` });
        });
      }
      rows.push({
        key: "effort",
        value: step.effort ?? agent?.effort ?? "engine default",
        ...(step.effort !== undefined ? { source: line([...at, "effort"]) } : agent?.effort !== undefined ? { source: agentFile! } : {}),
      });
      const computer = computerOf(step);
      rows.push({
        key: "computer",
        value: COMPUTER_WORDS[computer](automation.name),
        ...(computer !== "none" && computer !== "code" && !cloud && (env.host === "this-mac" || env.host === "laptop") ? { detail: `On ${HOST_WORDS[env.host]}, which is not isolated.` } : {}),
        source: step.computer !== undefined ? line([...at, "computer"]) : "default",
      });
      rows.push({
        key: "attempts",
        value: `${retries + 1}, at most ${formatDuration(timeoutMsOf(step))} each`,
        source: step.retries !== undefined ? line([...at, "retries"]) : step.timeout !== undefined ? line([...at, "timeout"]) : "default",
      });
      if (step.parallel !== undefined) {
        rows.push({
          key: "parallel",
          value: `${step.parallel} attempts at once, pick ${step.pick ?? "best"}`,
          detail: (step.pick ?? "best") === "first" ? "The first attempt whose checks pass wins; the others stop." : "Every attempt runs its checks; when more than one passes, a reviewer picks.",
          source: line([...at, "parallel"]),
        });
      }
      if (step.outcome !== undefined) {
        rows.push({
          key: "outcome",
          value: `graded against its rubric, up to ${step.outcome.max_iterations ?? DEFAULT_ITERATIONS} times`,
          detail: "After the checks pass, a separate grader scores the work; work that falls short runs again with the grader's feedback.",
          source: line([...at, "outcome"]),
        });
      }
      if (step.checks !== undefined && step.checks.length > 0) {
        rows.push({
          key: "checks",
          value: step.checks.map((c) => (typeof c === "string" ? c : `agent:${c.agent}`)).join(", "),
          detail: "Run by the runtime, credentials stripped; a failure starts the next attempt.",
          source: line([...at, "checks"]),
        });
        // What each agent check costs: its own model when its file sets one, else the step's.
        for (const check of step.checks) {
          if (typeof check === "string") continue;
          const checker = agents.get(check.agent);
          const own = checker?.model !== undefined && checker.model !== "inherit";
          const checkerFile = checker === undefined ? undefined : checker.source === "builtin" ? "built-in" : checker.path !== undefined ? shortPath(checker.path) : checker.source;
          const row = own ? modelRow("checker", checker.model, checker.engine ?? env.defaultEngine, env, undefined) : modelRow("checker", stepModel, engine, env, undefined);
          rows.push({ key: "checker", value: `${check.agent}: ${row.value}`, ...(row.detail ? { detail: row.detail } : {}), source: own ? checkerFile! : "the step's model" });
        }
      }
      const earlier = graph ? (step.needs ?? []) : stepNames.slice(0, Math.min(index, LISTED));
      const earlierCount = graph ? earlier.length : index;
      const trigger = file.on?.github ? `the ${eventsOf(file.on.github).join(" or ")} event` : file.on?.schedule ? "the schedule tick" : "";
      // A pull request run also sees this step's result from the last run on that pull request (runner previousOf).
      const pull = file.on?.github !== undefined && eventsOf(file.on.github).some((e) => e.startsWith("pull_request."));
      const sees = [trigger, file.inputs ? "the run's inputs" : "", pull ? "its result from the last run on the pull request" : "", earlierCount > 0 ? `results of ${someOf(earlier, earlierCount)}` : ""].filter(Boolean);
      rows.push({
        key: "sees",
        value: sees.length > 0 ? sees.join("; ") : "only its instructions",
        detail: `As data blocks after its instructions, never as instructions${earlierCount > 0 ? "; a result only when that step ran" : ""}.`,
      });
      if (step.if !== undefined) rows.push(ifRow(step.if, at));
      if (engines.size > 1) rows.push(...leverRows(engine));
      rows.push(...outputRows(name));
      return { name, source: `${shortPath(automation.path)}:${yaml.at(at, "key").line}`, rows };
    });

  return { automation: automation.name, scope: automation.scope, path: automation.path, header, steps };
}

function modelRow(key: string, asked: string | undefined, engine: string, env: EnvSnapshot, source: string | undefined): ExplainRow {
  const classes = env.classes[engine];
  const from = source === undefined ? {} : { source };
  if (asked === undefined || asked === "inherit") return { key, value: "the engine's default", ...from };
  if (asked === "auto") return { key, value: "auto", detail: "Caveman Auto picks the model and effort each turn.", ...from };
  if (isModelClass(asked)) {
    const resolved = classes?.[asked];
    if (resolved !== undefined) return { key, value: `${asked} · ${resolved}`, source: `class map: ${classes!.source}` };
    if (env.offline) return { key, value: `${asked} (resolves when Caveman Code runs)`, ...from };
    return { key, value: asked, detail: `No ${asked} model is set for ${engine} here.`, ...from };
  }
  if (isClaudeAlias(asked)) return { key, value: asked, detail: "A Claude alias; the engine resolves it.", ...from };
  return { key, value: asked, detail: "Pinned.", ...from };
}

/**
 * The aligned text `caveman explain` prints: key, value, where it comes from; a detail line under the value. The
 * title line names the automation, its scope and file, then its description, so a card can be filled from it.
 * `levers: true` adds each lever under the one harness row (for a CLI `--levers`).
 */
export function renderExplain(e: Explanation, options: { readonly levers?: boolean } = {}): string {
  const shown = (rows: ReadonlyArray<ExplainRow>) => (options.levers ? rows : rows.filter((r) => r.key !== "lever"));
  const all = [...shown(e.header), ...e.steps.flatMap((s) => shown(s.rows))];
  // A loop, not Math.max(...): a file of many steps has more rows than one call takes as arguments.
  let keyWidth = -Infinity;
  let widest = -Infinity;
  for (const r of all) {
    keyWidth = Math.max(keyWidth, r.key.length);
    if (r.source !== undefined) widest = Math.max(widest, r.value.length);
  }
  const valueWidth = Math.min(40, widest);
  const indent = " ".repeat(keyWidth + 4);
  const block = (title: string, where: string, rows: ReadonlyArray<ExplainRow>) => {
    const lines = [`${title.padEnd(keyWidth + valueWidth + 4)}  ${where}`];
    rows.forEach((row, i) => {
      if (row.key === "description") return lines.push(`  ${row.value}`);
      // A lever sits under the harness row, as its detail.
      const key = row.key === "lever" || (i > 0 && rows[i - 1]!.key === row.key) ? "" : row.key;
      const left = `  ${key.padEnd(keyWidth)}  ${row.key === "lever" ? `· ${row.value}` : row.value}`;
      lines.push(row.source === undefined ? left : `${left.padEnd(keyWidth + valueWidth + 4)}  ${row.source}`);
      if (row.detail !== undefined) lines.push(`${indent}${row.detail}`);
    });
    return lines.join("\n");
  };
  const header = shown(e.header);
  const untitled = header.some((r) => r.key === "description")
    ? []
    : [{ key: "description", value: "No description: add one line, description: <what it does>, so lists and cards have a title." }];
  const title = `${e.automation} · ${e.scope === "me" ? "Me" : "Project"}`;
  return [block(title, e.path, [...untitled, ...header]), ...e.steps.map((s) => block(s.name, s.source, shown(s.rows)))].join("\n\n");
}

/** A paths filter in words: `touching src/**`, `touching anything but docs/**`, or both. */
function pathWords(paths: ReadonlyArray<string>): string {
  const include = paths.filter((p) => !p.startsWith("!"));
  const exclude = paths.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  if (include.length === 0) return exclude.length === 0 ? "" : `touching anything but ${exclude.join(", ")}`;
  return `touching ${include.join(", ")}${exclude.length === 0 ? "" : `, but not ${exclude.join(", ")}`}`;
}
