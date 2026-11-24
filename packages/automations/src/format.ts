/**
 * The automation file, v1, as people write it (`.caveman/automations/<name>.yaml`).
 * One Effect Schema is the source of truth: the parser decodes with it, the
 * unknown-key check reads its fields, and `schema/automation-v1.json` is
 * generated from it. Values stay in their written form (`budget: $6`,
 * `timeout: 30m`); `budgetOf` and `durationMs` read them.
 *
 * @module format
 */
import * as Schema from "effect/Schema";

const { optionalKey } = Schema;

export const AUTOMATION_SCHEMA_URL = "https://caveman.so/schemas/automation-v1.json";

/** One naming rule for automations (the file name), steps and decisions: `fix-tests`, `needs_info`. */
// No "__": Cloud labels a step `<automation>__<step>`, and that split must stay unambiguous.
export const NAME_PATTERN = /^(?!.*__)[a-z][a-z0-9_-]{0,39}$/;
/** The agent registry's rule (Claude-compatible file names). */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
/** A decision value a `decides` list may hold: the same rule as names. */
export const DECISION_PATTERN = NAME_PATTERN;
/** What a name breaks, in words, for every message that asks for one. */
export const NAME_RULE = "lowercase letters, digits, - and _ (never two _ in a row), starting with a letter, at most 40 characters";

export const MODEL_CLASSES = ["fast", "base", "frontier"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];
/** Claude's aliases: accepted as pins by alias. A class works on every engine. */
export const CLAUDE_ALIASES = ["haiku", "sonnet", "opus"] as const;
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const COMPUTERS = ["none", "code", "readonly", "full"] as const;
export type Computer = (typeof COMPUTERS)[number];
/** What a step gets when its file says nothing: it can read the repo, never write it. */
export const DEFAULT_COMPUTER: Computer = "readonly";

/** The GitHub events the Caveman Code poller sees on This Mac. */
export const POLLED_GITHUB_EVENTS = [
  "issues.opened",
  "issues.labeled",
  "pull_request.opened",
  "pull_request.synchronize",
  "issue_comment.created",
  "push",
  "workflow_run.completed",
] as const;
/** Events only Caveman Cloud's GitHub App hears (it is pushed every webhook; This Mac polls). */
export const CLOUD_GITHUB_EVENTS = ["pull_request.labeled", "pull_request.closed", "check_suite.completed"] as const;
export const GITHUB_EVENTS = [...POLLED_GITHUB_EVENTS, ...CLOUD_GITHUB_EVENTS] as const;
export type GitHubEvent = (typeof GITHUB_EVENTS)[number];
export const LINEAR_EVENTS = ["issue.created", "issue.labeled", "comment.mention"] as const;
export const JIRA_EVENTS = ["issue.created", "issue.labeled"] as const;
/** Triggers only Caveman Cloud fires: nothing can push a Slack, Linear or Jira event to a Mac. */
export const CLOUD_TRIGGERS = ["slack", "linear", "jira"] as const;
/** Outputs Caveman Cloud posts for a run (POST /code/runtime/outputs); This Mac holds no token for them. */
export const CLOUD_OUTPUTS = ["slack.message", "linear.comment", "jira.comment"] as const;
export type CloudOutput = (typeof CLOUD_OUTPUTS)[number];
/** GitHub `author_association` values that may fire a trigger. The default is all three. */
export const TRUSTED_ACTORS = ["owner", "member", "collaborator"] as const;
export const CONCLUSIONS = ["failure", "success", "cancelled", "timed_out"] as const;
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** Values no `decides` list may use: the runtime's own step statuses. */
export const RESERVED_DECISIONS = ["failed", "succeeded", "skipped", "cancelled"] as const;
/** A routine's finding: of the runs with a `chief` output, only one whose step decided this wakes the Chief. */
export const NEWS_DECISION = "news";
/** What an agent check must decide, exactly. */
export const REVIEW_DECISIONS = ["approve", "request_changes"] as const;

/** Engines an agent may name (Session Protocol `EngineId`), plus `acp:<registry-id>`. */
export const ENGINES = ["caveman", "claude-agent", "codex", "cursor", "opencode", "muse", "grok", "pi", "antigravity"] as const;
export const ACP_ENGINE_PATTERN = /^acp:[a-z0-9][a-z0-9._-]*$/;

export const MAX_RETRIES = 3;
/** SEMANTICS §4.1: 2 to 4 attempts at once. */
export const MAX_PARALLEL = 4;
export const PICKS = ["first", "best"] as const;
export const APPROVERS = ["owner", "members"] as const;
/** SEMANTICS §5.3: an approval waits 72 h by default and 14 days at most. */
export const DEFAULT_APPROVAL_MS = 72 * 3_600_000;
export const MAX_APPROVAL_MS = 14 * 24 * 3_600_000;
/** The longest a wait step may hold a run: a week. */
export const MAX_WAIT_MS = 7 * 24 * 3_600_000;
export const MAX_ITERATIONS = 5;
/** A rubric gets this many tries when the file does not say. */
export const DEFAULT_ITERATIONS = 2;
export const MIN_EVERY_MS = 5 * 60_000;
/** SEMANTICS §10: 30 min for `full`, 10 min otherwise; the run stops at 2 h. */
export const DEFAULT_TIMEOUT_MS = { full: 30 * 60_000, other: 10 * 60_000 } as const;
export const RUN_DEADLINE_MS = 2 * 3_600_000;
/** A step can never outlast its run, so the run's deadline is a step's ceiling too (v1). */
export const MAX_TIMEOUT_MS = RUN_DEADLINE_MS;

// Patterns carry the `u` flag so they reach the JSON Schema.
const pattern = (re: RegExp, description: string) => Schema.String.check(Schema.isPattern(re)).annotate({ description });

export const Duration = pattern(/^[1-9][0-9]*(s|m|h)$/u, "A duration: 90s, 30m or 2h.");
export const ModelClassSchema = Schema.Literals(MODEL_CLASSES).annotate({
  description: "A model class, resolved where the step runs: fast, base or frontier.",
});
/** A pinned model: `provider/model`. */
export const PIN_PATTERN = /^[a-z0-9][a-z0-9.-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
export const Model = Schema.Union([
  Schema.Literals(["auto", ...MODEL_CLASSES]),
  Schema.Literals(CLAUDE_ALIASES),
  pattern(PIN_PATTERN, "A pinned model: provider/model."),
]).annotate({
  description: "auto (Caveman Auto picks per turn), a class (fast, base, frontier), or a pin like anthropic/claude-sonnet-5-5.",
});
const StringOrList = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

/** One rung of an escalation ladder: what attempt 2 (then 3, ...) runs on. */
export const Rung = Schema.Struct({
  model: optionalKey(Model),
  engine: optionalKey(Schema.String.annotate({ description: "Another engine for this rung: caveman, claude-agent, codex, or acp:<id>." })),
  effort: optionalKey(Schema.Literals(EFFORTS)),
}).annotate({ title: "Escalation rung" });
export type Rung = typeof Rung.Type;

export const Check = Schema.Union([
  Schema.String.check(Schema.isNonEmpty()).annotate({ description: "A command the runtime runs in the step's computer; exit 0 passes." }),
  Schema.Struct({
    agent: Schema.String.annotate({ description: "An agent that decides approve or request_changes." }),
  }),
]);

export const Step = Schema.Struct({
  agent: optionalKey(
    Schema.String.annotate({ description: "The agent that does this step: .caveman/agents/<name>.md, .claude/agents, ~/.caveman/agents or a built-in." }),
  ),
  prompt: optionalKey(Schema.String.annotate({ description: "Instructions for this step, instead of an agent." })),
  if: optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description: "Run only when earlier steps decided these values (all must hold), e.g. { triage: implement }. A value is one of that step's decides, or failed.",
    }),
  ),
  decides: optionalKey(
    Schema.Array(pattern(/^[a-z][a-z0-9_-]{0,39}$/u, "A decision: lowercase letters, digits, - and _.")).annotate({
      description:
        "For a prompt or run step: the values its decision may take, like [news, quiet]. A run step's command prints decision: <value> as its last line. An agent's decides live in its file.",
    }),
  ),
  model: optionalKey(Model),
  effort: optionalKey(Schema.Literals(EFFORTS).annotate({ description: "How hard the model thinks." })),
  escalate: optionalKey(
    Schema.Union([ModelClassSchema, Schema.Array(Rung)]).annotate({
      description: "What later attempts run on: a class for attempts 2 and later, or a ladder like [{ model: frontier }, { engine: codex }] (attempt 2 the first rung, 3 the next; the last one repeats).",
    }),
  ),
  computer: optionalKey(
    Schema.Literals(COMPUTERS).annotate({
      description: "none: no checkout. code: no checkout; runs JavaScript programs over its tools. readonly (default): a copy at the run's commit; changes are discarded. full: the run's worktree; changes are committed.",
    }),
  ),
  checks: optionalKey(Schema.Array(Check).annotate({ description: "Run by the runtime after the agent finishes, in order; the first failure fails the attempt." })),
  retries: optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_RETRIES })).annotate({ description: "More attempts after the first when checks fail: 0 to 3." }),
  ),
  timeout: optionalKey(Duration.annotate({ description: "Per attempt, checks included. Default 30m for full, 10m otherwise; at most 2h, the run's deadline." })),
  needs: optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "Steps that must finish first. A file where any step has needs runs as a graph: a step starts once its needs succeeded, beside others that are ready.",
    }),
  ),
  parallel: optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: MAX_PARALLEL })).annotate({ description: "Attempts at once, each in its own copy: 2 to 4. Needs at least one check." }),
  ),
  pick: optionalKey(
    Schema.Literals(PICKS).annotate({ description: "With parallel: first (the first attempt that passes its checks) or best (every passing attempt, then a reviewer picks)." }),
  ),
  approve: optionalKey(
    Schema.Struct({
      by: Schema.Literals(APPROVERS).annotate({ description: "owner: the automation's owner. members: anyone in the org who may write to the repository." }),
      timeout: optionalKey(Duration.annotate({ description: "How long the run waits for an answer: default 72h, at most 336h (14 days)." })),
    }).annotate({ description: "After the step succeeds, the run waits until a person approves it; its outputs and the steps after it wait too." }),
  ),
  wait: optionalKey(Duration.annotate({ description: "A step that only waits this long (at most 168h); the wait survives restarts." })),
  run: optionalKey(
    Schema.String.check(Schema.isNonEmpty()).annotate({ description: "A command the runtime runs in the step's computer, with no model; exit 0 succeeds." }),
  ),
  outcome: optionalKey(
    Schema.Struct({
      rubric: Schema.String.check(Schema.isNonEmpty()).annotate({ description: "What a finished step must meet, in words. A separate grader scores the work against it." }),
      max_iterations: optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_ITERATIONS })).annotate({ description: "Times the step may run to meet the rubric, with the grader's feedback each time: 1 to 5, default 2." }),
      ),
    }).annotate({ description: "After the checks pass, a grader scores the step against a rubric; work that falls short goes back with its feedback." }),
  ),
}).annotate({ title: "Step" });
export type Step = typeof Step.Type;

export const GitHubTrigger = Schema.Struct({
  event: Schema.Union([Schema.Literals(GITHUB_EVENTS), Schema.Array(Schema.Literals(GITHUB_EVENTS))]),
  label: optionalKey(StringOrList.annotate({ description: "Only issues or pull requests with one of these labels." })),
  paths: optionalKey(StringOrList.annotate({ description: "Only pushes and pull requests that change a file matching one of these globs." })),
  branches: optionalKey(StringOrList.annotate({ description: "Only these branches." })),
  actors: optionalKey(
    Schema.Union([Schema.Literal("any"), Schema.Array(Schema.Literals(TRUSTED_ACTORS))]).annotate({
      description: "Who may fire it, by GitHub author association. Default: owner, member, collaborator.",
    }),
  ),
  mention: optionalKey(Schema.Boolean.annotate({ description: "issue_comment.created: only comments that mention @caveman." })),
  conclusion: optionalKey(Schema.Literals(CONCLUSIONS).annotate({ description: "workflow_run.completed and check_suite.completed: only runs that ended this way." })),
  merged: optionalKey(Schema.Boolean.annotate({ description: "pull_request.closed: only pull requests that were merged (true) or closed unmerged (false)." })),
}).annotate({ title: "GitHub trigger" });
export type GitHubTrigger = typeof GitHubTrigger.Type;

/** `last` in monthdays: the month's last day, whatever its length. */
export const LAST_DAY = "last";

export const ScheduleTrigger = Schema.Struct({
  at: optionalKey(pattern(/^([01][0-9]|2[0-3]):[0-5][0-9]$/u, "A 24-hour time of day, quoted: \"09:00\".")),
  timezone: optionalKey(Schema.String.annotate({ description: "An IANA time zone, like Europe/Amsterdam. Required with at, once, cron, start and until." })),
  weekdays: optionalKey(Schema.Array(Schema.Literals(WEEKDAYS)).annotate({ description: "Days for at; every day when absent." })),
  monthdays: optionalKey(
    Schema.Array(Schema.Union([Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 })), Schema.Literal(LAST_DAY)])).annotate({
      description: "Days of the month for at, 1 to 31 or last. A month without the day skips it; last is always its last day.",
    }),
  ),
  every: optionalKey(
    pattern(/^[1-9][0-9]*(s|m|h|d|w)$/u, "An interval of at least 5m, like 6h; with at, every Nth day or week, like 2d or 2w.").annotate({
      description: "Alone, an interval of at least 5m (s, m or h). With at, every Nth day (2d) or, with weekdays, every Nth week (2w), counted from start.",
    }),
  ),
  once: optionalKey(pattern(/^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]([01][0-9]|2[0-3]):[0-5][0-9]$/u, "A date and 24-hour time in timezone, quoted: \"2026-11-09 09:00\". Runs once.")),
  cron: optionalKey(Schema.String.annotate({ description: "A five-field cron expression read in timezone, like \"0 9 * * 1-5\"; L is a month's last day." })),
  start: optionalKey(pattern(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u, "The first day it may run, in timezone, quoted: \"2026-11-09\". Every 2d or 2w counts from it.")),
  until: optionalKey(pattern(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u, "The last day it may run, in timezone, quoted: \"2026-12-31\".")),
  count: optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Stop after this many scheduled runs; runs by hand do not count." })),
}).annotate({ title: "Schedule trigger" });
export type ScheduleTrigger = typeof ScheduleTrigger.Type;

/** `every` with `at`: every Nth day or week. Undefined for an interval (s, m, h) or anything else. */
export function calendarStep(every: string | undefined): { readonly n: number; readonly unit: "day" | "week" } | undefined {
  const m = every === undefined ? null : /^([1-9][0-9]*)(d|w)$/.exec(every);
  return m === null ? undefined : { n: Number(m[1]), unit: m[2] === "d" ? "day" : "week" };
}

/** A real calendar date "YYYY-MM-DD" (no 30 February), as its parts. */
export function civilDate(text: string): { readonly year: number; readonly month: number; readonly day: number } | undefined {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})/.exec(text);
  if (m === null) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? { year, month, day } : undefined;
}

export const SlackTrigger = Schema.Struct({
  mention: optionalKey(Schema.Literal(true).annotate({ description: "A message that mentions @caveman (the only Slack event so far)." })),
  channels: optionalKey(Schema.Array(Schema.String).annotate({ description: "Only these channels, by name (#triage) or id; every channel the app is in when absent." })),
}).annotate({ title: "Slack trigger" });
export type SlackTrigger = typeof SlackTrigger.Type;

export const LinearTrigger = Schema.Struct({
  events: optionalKey(Schema.Array(Schema.Literals(LINEAR_EVENTS)).annotate({ description: "issue.created, issue.labeled, comment.mention; all three when absent." })),
  labels: optionalKey(Schema.Array(Schema.String).annotate({ description: "Only issues with one of these labels." })),
  team: optionalKey(Schema.String.annotate({ description: "Only this team's issues, by key (ENG)." })),
}).annotate({ title: "Linear trigger" });
export type LinearTrigger = typeof LinearTrigger.Type;

export const JiraTrigger = Schema.Struct({
  events: optionalKey(Schema.Array(Schema.Literals(JIRA_EVENTS)).annotate({ description: "issue.created, issue.labeled; both when absent." })),
  labels: optionalKey(Schema.Array(Schema.String).annotate({ description: "Only issues with one of these labels." })),
  project: optionalKey(Schema.String.annotate({ description: "Only this project's issues, by key (OPS)." })),
}).annotate({ title: "Jira trigger" });
export type JiraTrigger = typeof JiraTrigger.Type;

export const On = Schema.Struct({
  github: optionalKey(GitHubTrigger),
  schedule: optionalKey(ScheduleTrigger),
  webhook: optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Never)).annotate({ description: "A signed request to the automation's URL." })),
  slack: optionalKey(SlackTrigger.annotate({ description: "A Slack message that mentions @caveman (host: cloud)." })),
  linear: optionalKey(LinearTrigger.annotate({ description: "A Linear issue created or labelled, or a comment that mentions @caveman (host: cloud)." })),
  jira: optionalKey(JiraTrigger.annotate({ description: "A Jira issue created or labelled (host: cloud)." })),
}).annotate({ description: "What starts a run. Running it by hand always works." });
export type On = typeof On.Type;

export const Input = Schema.Struct({
  description: optionalKey(Schema.String),
  required: optionalKey(Schema.Boolean),
  default: optionalKey(Schema.String),
});

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const Usd = Schema.Finite.check(Schema.isGreaterThan(0));
export const Budget = Schema.Union([
  Usd,
  pattern(/^\$?[0-9]+(\.[0-9]{1,2})?$/u, "Dollars: $6 or $1.50."),
  Schema.Struct({ usd: optionalKey(Usd), tokens: optionalKey(PositiveInt), turns: optionalKey(PositiveInt) }),
]).annotate({ description: "The most one run may spend, across every step and attempt: $6, or { usd, tokens, turns }." });
export type Budget = typeof Budget.Type;

const StepField = pattern(/^[a-z][a-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_]*$/u, "<step>.<field>, like review.summary.");
const FromStep = Schema.Struct({ from: Schema.String, field: optionalKey(Schema.String) });
export const Outputs = Schema.Struct({
  "github.comment": optionalKey(
    Schema.Union([StepField, Schema.Struct({ from: Schema.String, field: optionalKey(Schema.String) })]).annotate({
      description: "One comment on the issue or pull request, edited by later runs.",
    }),
  ),
  "github.pull_request": optionalKey(
    Schema.Struct({ from: Schema.String, draft: optionalKey(Schema.Boolean) }).annotate({
      description: "A pull request from the run's branch. Its step must be computer: full.",
    }),
  ),
  "slack.message": optionalKey(
    Schema.Union([StepField, Schema.Struct({ ...FromStep.fields, channel: optionalKey(Schema.String) })]).annotate({
      description: "A Slack message: a reply in the thread that fired the run, or a post in channel. Cloud posts it (host: cloud).",
    }),
  ),
  "linear.comment": optionalKey(
    Schema.Union([StepField, FromStep]).annotate({ description: "A comment on the Linear issue that fired the run. Cloud posts it (host: cloud)." }),
  ),
  "jira.comment": optionalKey(
    Schema.Union([StepField, FromStep]).annotate({ description: "A comment on the Jira issue that fired the run. Cloud posts it (host: cloud)." }),
  ),
  chief: optionalKey(
    Schema.Struct({
      from: Schema.String,
      to: optionalKey(Schema.NonEmptyString.annotate({ description: "The Chief it reports to, by id. Absent, or that Chief gone: a Chief that works in the project." })),
    }).annotate({
      description: "Hands the step's summary to a Chief (to, else one that works in the project): its routine's row shows it, and a run that decided news wakes the Chief with it.",
    }),
  ),
}).annotate({ description: "What the runtime writes when the run ends. Agents hold no token for these." });
export type Outputs = typeof Outputs.Type;

/** Where a file's triggers fire: on the computer that has the repository (This Mac), or in Caveman Cloud. */
export const HOSTS = ["this-mac", "cloud"] as const;
export type Host = (typeof HOSTS)[number];

export const AutomationFile = Schema.Struct({
  version: optionalKey(Schema.Literal(1)),
  host: optionalKey(
    Schema.Literals(HOSTS).annotate({
      description: "Where its triggers fire: this-mac (default; Caveman Code on the computer with the repository) or cloud (on Cloud computers).",
    }),
  ),
  description: optionalKey(Schema.String.annotate({ description: "One line: what it does." })),
  on: optionalKey(On),
  inputs: optionalKey(Schema.Record(Schema.String, Input).annotate({ description: "Values a manual run asks for." })),
  budget: optionalKey(Budget),
  steps: Schema.Record(Schema.String, Step).annotate({
    description: "Steps run one at a time in file order; once any step has needs, they run as a graph, each when its needs are done.",
  }),
  outputs: optionalKey(Outputs),
}).annotate({ title: "Caveman automation", description: "A Caveman automation: steps, triggers, checks and outputs. https://caveman.so/docs/automations" });
export type AutomationFile = typeof AutomationFile.Type;

/** Keys that parse but mean nothing yet, each with what to do in v1. */
export const RESERVED_KEYS = {
  top: {
    optimize: "Every optimization with evidence behind it is on by default; caveman explain lists them.",
    concurrency: "Concurrency is fixed in v1: a new GitHub event replaces the running run, and a schedule tick skips while one runs.",
  },
  step: {
    delegate: "For now, put each agent in its own step, and use needs to run them side by side.",
    uses: "For now, write the step in this file.",
    budget: "For now, budget is set once for the whole run, at the top of the file.",
    optimize: "Every optimization with evidence behind it is on by default; caveman explain lists them.",
  },
  on: {},
  outputs: {
    file: "For now, outputs are github.comment, github.pull_request, slack.message, linear.comment, jira.comment and chief.",
    webhook: "For now, outputs are github.comment, github.pull_request, slack.message, linear.comment, jira.comment and chief.",
  },
} as const satisfies Record<string, Record<string, string>>;

/** Keys people write that have a better answer than "unknown key". */
export const KEY_HINTS: Readonly<Record<string, string>> = {
  manual: "Running by hand always works; remove manual.",
  name: "The file name is the automation's name.",
  model_class: "Use model: fast, base or frontier.",
};

// ------------------------------------------------------------------ readers

/** `30m` in milliseconds; undefined when it is not a duration. */
export function durationMs(text: string): number | undefined {
  const match = /^([1-9][0-9]*)(s|m|h)$/.exec(text);
  if (match === null) return undefined;
  return Number(match[1]) * (match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000);
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1_000)}s`;
  if (minutes < 60) return `${minutes}m`;
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface BudgetLimits {
  readonly usd?: number;
  readonly tokens?: number;
  readonly turns?: number;
}

/** The written budget as limits: `$6`, `6`, `"$1.50"` and `{ usd: 6 }` are all `{ usd: 6 }`. */
export function budgetOf(budget: Budget | undefined): BudgetLimits | undefined {
  if (budget === undefined) return undefined;
  if (typeof budget === "number") return { usd: budget };
  if (typeof budget === "string") return { usd: Number(budget.replace(/^\$/, "")) };
  return budget;
}

export const eventsOf = (github: GitHubTrigger): ReadonlyArray<GitHubEvent> => (typeof github.event === "string" ? [github.event] : github.event);

/**
 * What a run of this file is about, from its GitHub events: `issues.*` brings an issue, `pull_request.*` a pull
 * request, `issue_comment.created` either. Undefined when no event brings one (push, workflow_run, schedule only),
 * so a manual run has no subject to ask for.
 */
export function subjectKindOf(file: AutomationFile): "issue" | "pull_request" | "issue_or_pull_request" | undefined {
  const github = file.on?.github;
  if (github === undefined) return undefined;
  const events = eventsOf(github);
  const issue = events.some((e) => e.startsWith("issues.") || e === "issue_comment.created");
  const pullRequest = events.some((e) => e.startsWith("pull_request.") || e === "issue_comment.created");
  return issue && pullRequest ? "issue_or_pull_request" : issue ? "issue" : pullRequest ? "pull_request" : undefined;
}
export const listOf = (value: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  value === undefined ? [] : typeof value === "string" ? [value] : value;

/** The runs a file with any `needs` makes are a graph (SEMANTICS §1.2); without, steps run in file order. */
export const isGraph = (file: Pick<AutomationFile, "steps">): boolean => Object.values(file.steps).some((s) => s.needs !== undefined);

/** What a step is: an agent's work (agent or prompt), a command (run), or a timer (wait). */
export const stepKindOf = (step: Step): "agent" | "run" | "wait" => (step.run !== undefined ? "run" : step.wait !== undefined && step.agent === undefined && step.prompt === undefined ? "wait" : "agent");

/** The escalation ladder as rungs: `escalate: frontier` is one rung. */
export function rungsOf(escalate: Step["escalate"]): ReadonlyArray<Rung> {
  if (escalate === undefined) return [];
  if (typeof escalate === "string") return [{ model: escalate }];
  return escalate;
}

/** An output's source: `review.summary` or `{ from: review }` (field `summary`). */
export function outputSource(value: string | { readonly from: string; readonly field?: string }): { readonly step: string; readonly field: string } {
  if (typeof value !== "string") return { step: value.from, field: value.field ?? "summary" };
  const dot = value.indexOf(".");
  return { step: value.slice(0, dot), field: value.slice(dot + 1) };
}

export const isModelClass = (value: string | undefined): value is ModelClass => (MODEL_CLASSES as ReadonlyArray<string>).includes(value ?? "");
export const isClaudeAlias = (value: string | undefined): boolean => (CLAUDE_ALIASES as ReadonlyArray<string>).includes(value ?? "");
/** A model as an agent file may write it: auto, a class, a Claude alias, inherit, or provider/model. */
/**
 * A bare model id as Claude-compatible agent files write it (gpt-5.4-mini, claude-sonnet-5-5): a name with a
 * version, so a typo like "sonet" is still caught. The engine resolves it against its own model list.
 */
export const BARE_MODEL_ID_PATTERN = /^(?=.*\d)[a-z][a-z0-9.]*(?:-[a-z0-9.]+)+$/i;
export const isAgentModel = (value: string): boolean =>
  value === "auto" || value === "inherit" || isModelClass(value) || isClaudeAlias(value) || PIN_PATTERN.test(value) || BARE_MODEL_ID_PATTERN.test(value);
export const isEngine = (value: string): boolean => (ENGINES as ReadonlyArray<string>).includes(value) || ACP_ENGINE_PATTERN.test(value);
export const computerOf = (step: Step): Computer => step.computer ?? DEFAULT_COMPUTER;
/** A file that says nothing runs on This Mac. */
export const hostOf = (file: Pick<AutomationFile, "host">): Host => file.host ?? "this-mac";
/**
 * An output that only answers where the run's text came from: a Slack reply in the triggering thread (no
 * `channel`), a Linear or Jira comment on the triggering issue, a GitHub comment on the triggering issue or pull
 * request. It reaches the same people who wrote the text. A post to a channel and a pull request go elsewhere.
 */
export function repliesInPlace(kind: string, value: unknown): boolean {
  if (kind === "github.comment" || kind === "linear.comment" || kind === "jira.comment") return true;
  if (kind === "slack.message") return typeof value === "string" || (value !== null && typeof value === "object" && (value as { channel?: unknown }).channel === undefined);
  return false;
}
/** The steps an output reads that sends what they produce anywhere but the place the run's text came from. */
export function outputStepsElsewhere(file: Pick<AutomationFile, "outputs">): string[] {
  const steps = Object.entries(file.outputs ?? {}).flatMap(([kind, value]) =>
    value === undefined || value === null || repliesInPlace(kind, value) ? [] : [outputSource(value as string | { from: string; field?: string }).step],
  );
  return [...new Set(steps)];
}
/**
 * The steps that can write (SECURITY M1): a full computer (the run's branch, a push, a pull request), or a step an
 * output reads that posts anywhere but the thread or issue the run came from. When the run's trigger text came from
 * outside the trusted people, each waits for the owner's approval before it runs. A reply in that same place does
 * not: it reaches the people who wrote the text.
 */
export function writingSteps(file: Pick<AutomationFile, "steps" | "outputs">): string[] {
  const elsewhere = new Set(outputStepsElsewhere(file));
  return Object.entries(file.steps).filter(([name, step]) => stepKindOf(step) !== "wait" && (computerOf(step) === "full" || elsewhere.has(name))).map(([name]) => name);
}
/** The triggers that take text from outside the org: Slack, Linear, Jira, a webhook, and GitHub with actors: any. */
export function outsiderTriggers(file: Pick<AutomationFile, "on">): string[] {
  const on = file.on ?? {};
  return [
    ...(on.github !== undefined && on.github.actors === "any" ? ["on.github"] : []),
    ...(["slack", "linear", "jira"] as const).filter((k) => on[k] !== undefined).map((k) => `on.${k}`),
    ...(on.webhook !== undefined ? ["on.webhook"] : []),
  ];
}
/** How long an approval waits (SEMANTICS §5.3). */
export const approvalMsOf = (step: Step): number =>
  (step.approve?.timeout === undefined ? undefined : durationMs(step.approve.timeout)) ?? DEFAULT_APPROVAL_MS;
export const timeoutMsOf = (step: Step): number =>
  (step.timeout === undefined ? undefined : durationMs(step.timeout)) ?? (computerOf(step) === "full" ? DEFAULT_TIMEOUT_MS.full : DEFAULT_TIMEOUT_MS.other);
