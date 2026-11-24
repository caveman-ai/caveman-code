import type { AutomationExplanation, AutomationTemplateSummary } from "@caveman-app/session-protocol";
import { describe, expect, it } from "vitest";
import { parseAutomation } from "../../../../../packages/automations/src/index.ts";
import {
  agentsUsed,
  ago,
  attemptsNote,
  budgetUsd,
  canRun,
  conditionParts,
  attemptModel,
  type Automation,
  countsWord,
  deleteWords,
  deliveryView,
  duration,
  fileRef,
  filterAutomations,
  filterTemplates,
  headerFacts,
  inputsWord,
  lastRunView,
  legacyCanBeFile,
  awaitingAllow,
  onCloudSchedule,
  leverView,
  needsForm,
  nextRunWord,
  problemsOf,
  renamedWords,
  runHeading,
  subjectFrom,
  subjectLine,
  triggersOff,
  legacyToYaml,
  LOCAL_ZONE,
  leversOf,
  liveAttempt,
  modelView,
  money,
  NO_FILTER,
  offsetOf,
  problemsWord,
  type RunRecord,
  SCHEMA_LINE,
  slug,
  spendWord,
  startedBy,
  stepCards,
  stripCells,
  stripLabel,
  subjectView,
  subline,
  templateTabs,
  triggerMark,
  triggerSummary,
  triggerText,
  triggerWord,
  withSchemaLine,
  zoneWord,
  agentRunWord,
  runWho,
  scheduleZoneOf,
  threadOf,
} from "./model.ts";

/** A time of day as this computer's locale says it, the way the page does. */
const clock = (h: number, m: number) => new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const file = (over: Partial<Automation> = {}): Automation => ({
  id: "file:p1:project:issue-to-pr",
  title: "Issue to PR",
  prompt: "",
  enabled: true,
  trigger: { type: "file", kinds: ["manual", "github"], words: ["Issue labelled caveman", "By hand"] },
  project_id: "p1",
  engine: "caveman",
  model: "auto",
  next_run_at: null,
  last_run_at: null,
  last_status: "never",
  last_error: null,
  run_count: 0,
  source: "file",
  scope: "project",
  on_default_branch: true,
  ...over,
});

describe("triggers", () => {
  it("says what starts an automation, a file's By hand only when nothing else does", () => {
    expect(triggerText({ type: "interval", every_minutes: 30 })).toBe("Every 30 minutes");
    expect(triggerText({ type: "interval", every_minutes: 60 })).toBe("Every hour");
    expect(triggerText({ type: "interval", every_minutes: 180 })).toBe("Every 3 hours");
    expect(triggerText({ type: "daily", time: "09:00", weekdays: [5, 1, 2, 3, 4] })).toBe(`Weekdays at ${clock(9, 0)}`);
    expect(triggerText({ type: "daily", time: "18:30" })).toBe(`Daily at ${clock(18, 30)}`);
    expect(triggerText({ type: "daily", time: "07:00", weekdays: [1, 3] })).toBe(`Mon, Wed at ${clock(7, 0)}`);
    expect(triggerText({ type: "daily", time: "07:00", weekdays: [1] })).toBe(`Monday at ${clock(7, 0)}`);
    expect(triggerText({ type: "daily", time: "10:00", weekdays: [6, 0] })).toBe(`Weekends at ${clock(10, 0)}`);
    expect(triggerText({ type: "webhook", path: "/hooks/x", url: null, signed: true })).toBe("Webhook, signed");
    expect(triggerText({ type: "github_mention", repo: "acme/api" })).toBe("@caveman in acme/api");
    expect(triggerText({ type: "monthly", time: "09:00", days: [15, -1] })).toBe(`Monthly on the 15th and last day at ${clock(9, 0)}`);
    expect(triggerText({ type: "cron", expression: "0 9 * * 1", timezone: LOCAL_ZONE, max_runs: 4 })).toBe("Cron 0 9 * * 1, 4 runs");
    expect(triggerText({ type: "daily", time: "07:00", every_days: 3 })).toBe(`Every 3 days at ${clock(7, 0)}`);
    expect(triggerText({ type: "once", run_at: "2026-11-09T08:00:00.000Z" })).toMatch(/^Once, \w+ Nov 9 at /);
    expect(triggerMark({ type: "once", run_at: "2026-11-09T08:00:00.000Z" })).toBe("schedule");
    expect(triggerText({ type: "file", kinds: ["manual", "github"], words: ["Issue labelled caveman", "By hand"] })).toBe("Issue labelled caveman");
    expect(triggerText({ type: "file", kinds: ["manual"], words: ["By hand"] })).toBe("By hand");
  });

  it("says a file's schedule once, the way people do, with another zone only when it isn't this computer's", () => {
    const here = "Europe/Amsterdam";
    expect(triggerWord("Weekdays at 09:00 (Europe/Amsterdam)", here)).toBe(`Weekdays at ${clock(9, 0)}`);
    expect(triggerWord("Weekdays at 09:00 (Europe/Amsterdam)", "America/Los_Angeles")).toBe(`Weekdays at ${clock(9, 0)} (Amsterdam)`);
    expect(triggerWord("Every day at 22:00 (America/Los_Angeles)", here)).toBe(`Daily at ${clock(22, 0)} (Los Angeles)`);
    expect(triggerWord("Mon at 07:00", here)).toBe(`Monday at ${clock(7, 0)}`);
    expect(triggerWord("Mon, Thu at 16:00 (UTC)", here)).toBe(`Mon, Thu at ${clock(16, 0)} (UTC)`);
    expect(triggerWord("Sat, Sun at 10:00", here)).toBe(`Weekends at ${clock(10, 0)}`);
    expect(triggerWord("Every 1h", here)).toBe("Every hour");
    expect(triggerWord("Every 15m", here)).toBe("Every 15 minutes");
    expect(triggerWord("Pull request opened or updated", here)).toBe("Pull request opened or updated");
    expect(zoneWord("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(triggerWord("Once on 2026-11-09 at 09:00 (Europe/Amsterdam)", here)).toMatch(new RegExp(`^Once, \\w+ Nov 9 at ${clock(9, 0)}$`));
    expect(triggerWord("Monthly on the 1st and last day at 18:00 (UTC)", here)).toBe(`Monthly on the 1st and last day at ${clock(18, 0)} (UTC)`);
    expect(triggerWord("Every 2 weeks on Mon at 10:00 (Europe/Amsterdam), from 2026-11-09", here)).toMatch(new RegExp(`^Every 2 weeks on Mon at ${clock(10, 0)}, from \\w+ Nov 9$`));
    expect(triggerWord("Cron 0 9 * * 1-5 (Europe/Amsterdam), 10 runs", here)).toBe("Cron 0 9 * * 1-5, 10 runs");
    expect(triggerWord("Weekdays at 09:00 (Europe/Amsterdam), until 2026-12-31", here)).toMatch(new RegExp(`^Weekdays at ${clock(9, 0)}, until \\w+ Dec 31$`));
  });

  it("gives a row one trigger and a count of the rest", () => {
    const words = ["Pull request opened or updated", "Weekdays at 09:00 (Europe/Amsterdam)", "By hand"];
    expect(triggerSummary({ type: "file", kinds: ["manual", "github", "schedule"], words }, "Europe/Amsterdam")).toBe("Pull request opened or updated +1");
    expect(triggerText({ type: "file", kinds: ["manual", "github", "schedule"], words }, "Europe/Amsterdam")).toBe(`Pull request opened or updated · Weekdays at ${clock(9, 0)}`);
    expect(triggerSummary({ type: "file", kinds: ["manual", "schedule"], words: ["Weekdays at 09:00 (Europe/Amsterdam)", "By hand"] }, "Europe/Amsterdam")).toBe(`Weekdays at ${clock(9, 0)}`);
    expect(triggerSummary({ type: "file", kinds: ["manual"], words: [] })).toBe("By hand");
  });

  it("wears the mark of the trigger that says most", () => {
    expect(triggerMark({ type: "file", kinds: ["manual", "schedule", "github"], words: [] })).toBe("github");
    expect(triggerMark({ type: "file", kinds: ["manual", "schedule"], words: [] })).toBe("schedule");
    expect(triggerMark({ type: "file", kinds: ["manual", "webhook"], words: [] })).toBe("webhook");
    expect(triggerMark({ type: "file", kinds: ["manual"], words: [] })).toBe("manual");
    expect(triggerMark({ type: "daily", time: "02:00" })).toBe("schedule");
    expect(triggerMark({ type: "github_mention", repo: "a/b" })).toBe("github");
  });

  it("reads a file id, and nothing else", () => {
    expect(fileRef("file:p-1:me:morning-digest")).toEqual({ project_id: "p-1", scope: "me", name: "morning-digest" });
    // A project added by path has an id with a colon in it.
    expect(fileRef("file:caveman-repo:116a69dfc5562dff:project:fix-bug")).toEqual({ project_id: "caveman-repo:116a69dfc5562dff", scope: "project", name: "fix-bug" });
    expect(fileRef("sched-7f3a")).toBeNull();
    expect(fileRef("file:p:team:x")).toBeNull();
  });

  it("reads the id of every file the runtime lists, underscores in its name too", () => {
    // .caveman/automations/nightly_report.yaml loads (NAME_RULE: lowercase letters, digits, - and _).
    expect(fileRef("file:p-1:project:nightly_report")).toEqual({ project_id: "p-1", scope: "project", name: "nightly_report" });
    expect(fileRef("file:p-1:me:a_b-c")).toEqual({ project_id: "p-1", scope: "me", name: "a_b-c" });
    expect(fileRef("file:p-1:project:_x")).toBeNull();
  });

  it("puts project, whose and trigger under the name", () => {
    expect(subline(file(), "caveman-cloud")).toBe("caveman-cloud · Project · Issue labelled caveman");
    expect(subline(file({ scope: "me" }), undefined)).toBe("Missing project · Me · Issue labelled caveman");
    expect(subline(file({ source: "app", trigger: { type: "daily", time: "02:00" } }), "api")).toBe(`api · Saved in the app · Daily at ${clock(2, 0)}`);
  });
});

describe("numbers", () => {
  it("always draws 30 days, oldest first", () => {
    expect(stripCells(undefined)).toHaveLength(30);
    expect(stripCells(["worked", "failed"]).slice(-3)).toEqual(["none", "worked", "failed"]);
    expect(stripCells(Array(40).fill("worked"))).toHaveLength(30);
    expect(stripLabel(stripCells(["worked", "worked", "failed"]))).toBe("Last 30 days: 2 days worked, 1 failed");
    expect(stripLabel(stripCells([]))).toBe("No runs in the last 30 days");
  });

  it("shows measured money, a dash for none", () => {
    expect(money(undefined)).toBe("—");
    expect(money(null)).toBe("—");
    expect(money(0)).toBe("$0");
    expect(money(0.004)).toBe("<$0.01");
    expect(money(14.2)).toBe("$14.20");
    expect(money(1204.5)).toBe("$1,205");
    expect(spendWord(0)).toBe("—");
    expect(spendWord(3.1)).toBe("$3.10");
  });

  it("reads durations at a glance", () => {
    expect(duration(400)).toBe("0s");
    expect(duration(41_000)).toBe("41s");
    expect(duration(125_000)).toBe("2m 05s");
    expect(duration(12 * 60_000 + 3000)).toBe("12m");
    expect(duration(64 * 60_000)).toBe("1h 04m");
  });

  it("says how long ago", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    expect(ago(null, now)).toBe("—");
    expect(ago("2026-10-20T11:59:40Z", now)).toBe("just now");
    expect(ago("2026-10-20T10:00:00Z", now)).toBe("2h ago");
  });
});

describe("runs", () => {
  it("links a GitHub subject and names the rest", () => {
    expect(subjectView("github:acme/api#812")).toEqual({ label: "#812", repo: "acme/api", url: "https://github.com/acme/api/issues/812" });
    expect(subjectView("github:acme/api@9e04c1a2b3")).toMatchObject({ label: "9e04c1a", url: "https://github.com/acme/api/commit/9e04c1a2b3" });
    expect(subjectView("manual")).toEqual({ label: "By hand" });
    expect(subjectView("schedule:2026-10-20T09:00")).toEqual({ label: "On schedule" });
  });

  const run = (steps: RunRecord["steps"]): RunRecord =>
    ({ run: "r", automation: "a", revision: "", trigger: { kind: "manual", subject: "manual", received_at: "" }, concurrency_key: "", status: "running", reason: null, started_at: "", ended_at: null, environment: "", population: "agent", registry: "", budget: { limit_usd: 6, spent_usd: 1, label: "measured" }, workspace: { computer: "this_mac", branch: "b", head: null }, steps, outputs: [] }) as RunRecord;
  const attempt = (n: number, over: object = {}) => ({ n, id: `r.s.${n}`, status: "succeeded" as const, reason: null, model: { asked: "base", resolved: "anthropic/claude-sonnet-5-5" }, started_at: "", ended_at: null, checks: [], sha: null, ...over });

  it("says what started a run", () => {
    expect(startedBy({ kind: "github", event: "issues.labeled", subject: "", received_at: "" })).toBe("issue labelled");
    expect(startedBy({ kind: "manual", subject: "manual", received_at: "" })).toBe("started by hand");
    expect(startedBy({ kind: "github", event: "check_suite.done", subject: "", received_at: "" })).toBe("check suite done");
  });

  it("names an attempt's model, its class and whether it escalated", () => {
    expect(attemptModel(attempt(2, { model: { asked: "frontier", resolved: "anthropic/claude-opus-5-5", via: "escalate" } }))).toEqual({ cls: "frontier", model: "Opus 5.5", escalated: true });
    expect(attemptModel(attempt(1, { model: { asked: "openai/gpt-6-luna", resolved: "openai/gpt-6-luna" } }))).toEqual({ model: "GPT-6 Luna", escalated: false });
  });

  it("says what the attempts were: first tries, retries, a bigger model", () => {
    expect(attemptsNote(run([{ name: "a", status: "succeeded", reason: null, attempts: [attempt(1)] }, { name: "b", status: "succeeded", reason: null, attempts: [attempt(1)] }]))).toBe("each step on its first try");
    expect(attemptsNote(run([{ name: "a", status: "succeeded", reason: null, attempts: [attempt(1), attempt(2, { model: { asked: "frontier", resolved: "x", via: "escalate" } })] }]))).toBe("1 retry, 1 moved up a class");
    expect(attemptsNote(run([{ name: "a", status: "pending", reason: null, attempts: [] }]))).toBe("none yet");
  });

  it("takes over the newest attempt of the step that runs now", () => {
    const r = run([
      { name: "triage", status: "succeeded", reason: null, attempts: [attempt(1)] },
      { name: "implement", status: "running", reason: null, attempts: [attempt(1, { status: "failed" }), attempt(2, { status: "running", workspace_id: "w-2" })] },
    ]);
    expect(liveAttempt(r)).toMatchObject({ step: "implement", attempt: { n: 2, workspace_id: "w-2" } });
    expect(liveAttempt(run([{ name: "a", status: "succeeded", reason: null, attempts: [attempt(1)] }]))).toBeNull();
  });
});

describe("the list", () => {
  const list = [
    file(),
    file({ id: "file:p2:me:digest", title: "Morning digest", scope: "me", project_id: "p2", trigger: { type: "file", kinds: ["manual", "schedule"], words: ["Weekdays at 09:00", "By hand"] } }),
    file({ id: "file:p2:project:flaky", title: "Fix flaky tests", project_id: "p2", on_default_branch: false, enabled: false }),
    file({ id: "file:p2:project:log", title: "Weekly changelog", project_id: "p2", diagnostics: 2, last_status: "failed" }),
    (({ scope: _scope, ...app }) => app)(file({ id: "sched-1", title: "Nightly audit", source: "app", trigger: { type: "daily", time: "02:00" } })),
  ];
  const name = (id: string) => ({ p1: "caveman-cloud", p2: "caveman-code" })[id];
  const titles = (f: Partial<typeof NO_FILTER>) => filterAutomations(list, { ...NO_FILTER, ...f }, name).map((a) => a.title);

  it("Mine is Me files and the app's own; All is everything", () => {
    expect(titles({ who: "mine" })).toEqual(["Morning digest", "Nightly audit"]);
    expect(titles({})).toHaveLength(5);
  });

  it("filters by project, trigger, state and words together", () => {
    expect(titles({ projects: ["p2"] })).toEqual(["Morning digest", "Fix flaky tests", "Weekly changelog"]);
    expect(titles({ triggers: ["schedule"] })).toEqual(["Morning digest", "Nightly audit"]);
    expect(titles({ states: ["off_main"] })).toEqual(["Fix flaky tests"]);
    expect(titles({ states: ["errors", "off"] })).toEqual(["Fix flaky tests", "Weekly changelog"]);
    expect(titles({ query: "cloud" })).toEqual(["Issue to PR", "Nightly audit"]);
    expect(titles({ query: "labelled", projects: ["p2"] })).toEqual(["Fix flaky tests", "Weekly changelog"]);
  });
});

const explanation: AutomationExplanation = {
  automation: "issue-to-pr",
  scope: "project",
  path: ".caveman/automations/issue-to-pr.yaml",
  header: [
    { key: "description", value: "Turn issues labelled caveman into reviewed draft pull requests" },
    { key: "triggers", value: "Issue labelled caveman · By hand" },
    { key: "runs on", value: "This Mac", detail: "Triggers fire in Caveman Code, which polls GitHub, from the default branch's copy of this file." },
    { key: "budget", value: "$6.00 per run, all attempts", source: "line 8" },
    { key: "worst case", value: "$6.00 or 1h 50m, whichever comes first", detail: "At most 5 attempts across 3 steps." },
    { key: "levers", value: "Caveman harness: on", source: "every lever on vs off: 17.5% less cost per attempt (measured)" },
    { key: "lever", value: "Cache-stable prefix: on", source: "lossless (n=212)" },
    { key: "lever", value: "Engine compression: off", source: "evidence negative (n=9)" },
  ],
  steps: [
    {
      name: "triage",
      source: "automations/issue-to-pr.yaml:11",
      rows: [
        { key: "agent", value: "issue-triage", source: "agents/issue-triage.md" },
        { key: "engine", value: "caveman", source: "the new-chat default" },
        { key: "model", value: "fast · deepseek/deepseek-v4.1-flash", source: "class map: Settings > Models" },
        { key: "effort", value: "engine default" },
        { key: "computer", value: "readonly: a copy at the run's commit; changes are discarded", source: "default" },
        { key: "attempts", value: "1, at most 10m each", source: "default" },
      ],
    },
    {
      name: "implement",
      source: "automations/issue-to-pr.yaml:14",
      rows: [
        { key: "agent", value: "builder", source: "built-in" },
        { key: "engine", value: "caveman" },
        { key: "model", value: "base · anthropic/claude-sonnet-5-5" },
        { key: "escalate", value: "frontier · anthropic/claude-opus-5-5", detail: "Attempts 2-3." },
        { key: "effort", value: "high", source: "line 19" },
        { key: "computer", value: "full: a worktree on branch caveman/issue-to-pr/<subject>" },
        { key: "attempts", value: "3, at most 30m each" },
        { key: "checks", value: "pnpm lint, pnpm test, agent:reviewer" },
        { key: "checker", value: "reviewer: base · anthropic/claude-sonnet-5-5", source: "the step's model" },
        { key: "runs if", value: "triage decided implement" },
        { key: "outputs", value: "github.pull_request, draft" },
      ],
    },
    {
      name: "ask",
      source: "automations/issue-to-pr.yaml:27",
      rows: [
        { key: "agent", value: "inline prompt", detail: '"Ask the author what is missing."' },
        { key: "model", value: "auto" },
        { key: "decides", value: "asked or skipped", source: "line 29" },
        { key: "computer", value: "none: no checkout" },
        { key: "attempts", value: "1, at most 10m each" },
        { key: "runs if", value: "triage decided needs_info" },
      ],
    },
  ],
};

describe("explain", () => {
  it("turns each step into a card", () => {
    const [triage, implement, ask] = stepCards(explanation);
    expect(triage).toMatchObject({ name: "triage", agent: { name: "issue-triage", from: "agents/issue-triage.md" }, model: { cls: "fast", model: "Deepseek V4.1 Flash" }, computer: { kind: "readonly" }, checks: [] });
    expect(triage!.effort).toBeUndefined();
    expect(triage!.attempts).toBe("Once, up to 10m");
    expect(triage!.runsIf).toBeUndefined();
    expect(implement).toMatchObject({
      model: { cls: "base", model: "Sonnet 5.5" },
      escalate: { cls: "frontier", model: "Opus 5.5", when: "Attempts 2-3" },
      effort: "high",
      computer: { kind: "full", words: "Edits its branch" },
      checks: ["pnpm lint", "pnpm test", "reviewer"],
      attempts: "Up to 3, 30m each",
      runsIf: "if triage decided implement",
      outputs: ["github.pull_request, draft"],
    });
    expect(ask).toMatchObject({ agent: { name: "Inline prompt", prompt: "Ask the author what is missing." }, model: { cls: "auto", model: "Caveman Auto" }, computer: { kind: "none" }, decides: "asked or skipped" });
    expect(implement!.checkers).toEqual({ reviewer: "the step's model" });
    const own = { ...explanation, steps: [{ ...explanation.steps[1]!, rows: [{ key: "checker", value: "reviewer: frontier · anthropic/claude-opus-5-5", source: "agents/reviewer.md" }] }] };
    expect(stepCards(own)[0]!.checkers).toEqual({ reviewer: "frontier · Opus 5.5" });
    expect(triage!.checkers).toEqual({});
  });

  it("states the header once, levers with their evidence verbatim", () => {
    const h = headerFacts(explanation);
    expect(h).toMatchObject({ triggers: "Issue labelled caveman · By hand", runsOn: "This Mac", budget: "$6.00 per run, all attempts", worstCase: "$6.00 or 1h 50m, whichever comes first" });
    expect(leversOf(explanation)).toEqual([
      { label: "Caveman harness", on: true, evidence: "every lever on vs off: 17.5% less cost per attempt (measured)" },
      { label: "Cache-stable prefix", on: true, evidence: "lossless (n=212)", detail: true },
      { label: "Engine compression", on: false, evidence: "evidence negative (n=9)", detail: true },
    ]);
  });

  it("shows the one harness row, its levers as detail, and never claims every step when engines differ", () => {
    const harness = { label: "Caveman harness", on: true, evidence: "every lever on vs off: 17.5% less cost per attempt (measured)" };
    expect(leverView(explanation)).toEqual({
      main: [harness],
      detail: [
        { label: "Cache-stable prefix", on: true, evidence: "lossless (n=212)", detail: true },
        { label: "Engine compression", on: false, evidence: "evidence negative (n=9)", detail: true },
      ],
      steps: null,
    });
    // An older explain marks nothing: its harness row is found by name, and with none, every lever shows.
    const old = (rows: AutomationExplanation["header"]) => ({ ...explanation, header: [...explanation.header.filter((r) => !r.key.startsWith("lever")), ...rows] });
    expect(leverView(old([{ key: "levers", value: "Caveman harness: on" }, { key: "levers", value: "Tool-output caps: on" }]))).toMatchObject({ main: [{ label: "Caveman harness" }], detail: [{ label: "Tool-output caps" }] });
    expect(leverView(old([{ key: "levers", value: "Tool-output caps: on" }, { key: "levers", value: "Terse turns: off" }]))).toMatchObject({ main: [{ label: "Tool-output caps" }, { label: "Terse turns" }], detail: [] });
    // Steps on different engines: levers live on the steps that have them.
    const row = { key: "levers", value: "Caveman harness: on", source: harness.evidence };
    const perStep: AutomationExplanation = {
      ...explanation,
      header: explanation.header.filter((r) => !r.key.startsWith("lever")),
      steps: explanation.steps.map((st, i) => ({ ...st, rows: [...st.rows, i === 1 ? { key: "levers", value: "none reported for codex" } : row] })),
    };
    expect(leverView(perStep)).toMatchObject({ main: [{ label: "Caveman harness" }], steps: ["triage", "ask"] });
  });

  it("reads a model row class first, and the older form", () => {
    expect(modelView({ value: "base · anthropic/claude-sonnet-5-5" })).toEqual({ cls: "base", model: "Sonnet 5.5" });
    expect(modelView({ value: "anthropic/claude-sonnet-5-5 (base)" })).toEqual({ cls: "base", model: "Sonnet 5.5" });
    expect(modelView({ value: "fast", detail: "No fast model is set for codex here." })).toEqual({ cls: "fast", model: "not set here", detail: "No fast model is set for codex here." });
    expect(modelView({ value: "fast (resolves when Caveman Code runs)" })).toMatchObject({ cls: "fast", model: "set when it runs" });
    expect(modelView({ value: "auto" })).toEqual({ cls: "auto", model: "Caveman Auto" });
    expect(modelView({ value: "openai/gpt-6-luna" })).toEqual({ model: "GPT-6 Luna" });
  });

  it("reads the budget and the conditions", () => {
    expect(budgetUsd(explanation)).toBe(6);
    expect(budgetUsd(undefined)).toBeUndefined();
    expect(conditionParts("if triage decided implement and lint failed")).toEqual([
      { step: "triage", value: "implement" },
      { step: "lint", value: "failed" },
    ]);
  });

  it("lists the agents a file uses, agent checks included, once each", () => {
    expect(agentsUsed(explanation)).toEqual([{ name: "issue-triage", from: "agents/issue-triage.md" }, { name: "builder", from: "built-in" }, { name: "reviewer" }]);
  });
});

describe("files", () => {
  it("keeps the schema line on automation files only", () => {
    expect(withSchemaLine("a.yaml", "version: 1\n")).toBe(`${SCHEMA_LINE}\nversion: 1\n`);
    expect(withSchemaLine("a.yaml", `${SCHEMA_LINE}\nversion: 1\n`)).toBe(`${SCHEMA_LINE}\nversion: 1\n`);
    expect(withSchemaLine(".caveman/agents/x.md", "---\n")).toBe("---\n");
  });

  it("names a file from words", () => {
    expect(slug("Fix flaky tests!")).toBe("fix-flaky-tests");
    expect(slug("2024 changelog")).toBe("changelog");
    expect(slug("   ")).toBe("automation");
    expect(slug("a".repeat(60))).toHaveLength(40);
  });

  it("jumps to a line and column", () => {
    const text = "ab\ncdef\ng";
    expect(offsetOf(text, 1, 1)).toBe(0);
    expect(offsetOf(text, 2, 3)).toBe(5);
    expect(offsetOf(text, 2, 99)).toBe(7);
    expect(offsetOf(text, 9, 1)).toBe(text.length);
  });

  it("counts problems in words", () => {
    const d = (severity: "error" | "warning") => ({ path: "a", line: 1, column: 1, severity, code: "x", message: "" });
    expect(problemsWord([])).toBe("No problems");
    expect(problemsWord([d("error"), d("error"), d("warning")])).toBe("2 errors, 1 warning");
  });

  it("writes an app-saved automation as a one-step file", () => {
    const yaml = legacyToYaml(file({ source: "app", title: "Nightly audit: deps", prompt: "Run pnpm audit.\nOpen one issue.", trigger: { type: "daily", time: "02:00", weekdays: [5, 1] } }), "Europe/Amsterdam");
    expect(yaml).toContain('schedule: { at: "02:00", timezone: Europe/Amsterdam, weekdays: [mon, fri] }');
    expect(yaml).toContain('description: "Nightly audit: deps"');
    expect(yaml).toContain("    prompt: |\n      Run pnpm audit.\n      Open one issue.\n");
    expect(legacyToYaml(file({ source: "app", trigger: { type: "interval", every_minutes: 120 } }), "UTC")).toContain("schedule: { every: 2h }");
    expect(legacyToYaml(file({ source: "app", trigger: { type: "github_mention", repo: "a/b" } }), "UTC")).toContain("github: { event: issue_comment.created, mention: true }");
    expect(legacyToYaml(file({ source: "app", trigger: { type: "once", run_at: "2026-11-09T08:00:00.000Z" } }), "Europe/Amsterdam")).toContain('schedule: { once: "2026-11-09 09:00", timezone: Europe/Amsterdam }');
    expect(legacyToYaml(file({ source: "app", trigger: { type: "monthly", time: "18:00", days: [1, -1], max_runs: 6 } }), "UTC")).toContain('schedule: { at: "18:00", timezone: UTC, monthdays: [1, last], count: 6 }');
    expect(legacyToYaml(file({ source: "app", trigger: { type: "cron", expression: "0 9 * * 1-5", timezone: "America/New_York", until: "2027-07-01T03:59:59.999Z" } }), "UTC")).toContain('schedule: { cron: "0 9 * * 1-5", timezone: America/New_York, until: "2027-06-30" }');
    expect(legacyToYaml(file({ source: "app", trigger: { type: "daily", time: "10:00", weekdays: [1], every_weeks: 2, start_at: "2026-11-09T00:00:00.000Z" } }), "UTC")).toContain('schedule: { at: "10:00", timezone: UTC, weekdays: [mon], every: 2w, start: "2026-11-09" }');
    expect(legacyCanBeFile(file({ source: "app", trigger: { type: "daily", time: "02:00" } }))).toBe(true);
    expect(legacyCanBeFile(file({ source: "app", trigger: { type: "webhook", path: "/h/x", url: null, signed: false } }))).toBe(false);
    expect(legacyCanBeFile(file())).toBe(false);
  });

  it("writes a file that loads, with the title as its description, whatever the title holds", () => {
    const titles = ["Daily standup summary", "Nightly audit: deps", "[Daily] standup summary", "@team digest", '"Weekly" report', "*nightly* audit", "> release notes", "{ops} cleanup", "`deps` audit", "- todo # later", "yes"];
    const loaded = titles.map((title) => {
      const text = legacyToYaml(file({ source: "app", title, prompt: "Summarise yesterday's notes.", trigger: { type: "daily", time: "09:00" } }), "Europe/Amsterdam");
      const { file: f, diagnostics } = parseAutomation({ path: ".caveman/local/automations/x.yaml", text });
      return { description: f?.description, errors: diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`) };
    });
    expect(loaded).toEqual(titles.map((title) => ({ description: title, errors: [] })));
  });

  it("an agent's schedule on Cloud waits for the person, keeps UTC, and never becomes a file of this Mac's", () => {
    const onCloud = file({ source: "app", host: "cloud", awaiting_approval: true, trigger: { type: "daily", time: "02:00", timezone: "UTC" } });
    expect(awaitingAllow(onCloud)).toBe(true);
    expect(awaitingAllow(file({ source: "app" }))).toBe(false);
    expect(onCloudSchedule(onCloud)).toBe(true);
    // A Cloud file is not one: it is deployed, not allowed.
    expect(onCloudSchedule(file({ host: "cloud" }))).toBe(false);
    expect(legacyCanBeFile(onCloud)).toBe(false);
    expect(triggerText(onCloud.trigger, "Europe/Amsterdam")).toBe("Daily at 2:00 AM (UTC)");
    expect(triggerText(onCloud.trigger, "UTC")).toBe("Daily at 2:00 AM");
    expect(deleteWords(onCloud).confirm).toMatch(/stops on its Cloud computer/);
  });
});

describe("deliveries", () => {
  const d = (over: Partial<Parameters<typeof deliveryView>[0]> = {}) => ({ outcome: "", error: null, ...over });

  it("links a started event's run, with what it was about", () => {
    expect(deliveryView(d({ status: "started", outcome: "Started r_4f1a.", run_id: "r_4f1a", event: "issues.labeled", subject: "github:acme/api#812", subject_title: "Export ignores currency" }))).toEqual({
      tone: "admitted",
      words: "Started a run",
      runId: "r_4f1a",
      event: "issue labelled",
      subject: { label: "#812", title: "Export ignores currency", repo: "acme/api", url: "https://github.com/acme/api/issues/812" },
    });
  });

  it("says a refusal's reason in words, the runtime's sentence beneath, red", () => {
    const why = "Opened by an outside contributor; outsiders never start runs on This Mac.";
    expect(deliveryView(d({ status: "refused", reason: "policy_denied", outcome: why, error: why }))).toMatchObject({ tone: "refused", words: "Refused by a safety rule", detail: why });
    expect(deliveryView(d({ status: "refused", reason: "needs_isolation", outcome: "x" }))).toMatchObject({ tone: "refused", words: "Refused: it needs an isolated computer" });
    // A run reason with no delivery words of its own reads as the run reason.
    expect(deliveryView(d({ status: "refused", reason: "deadline", outcome: "x" }))).toMatchObject({ tone: "refused", words: "Refused: hit the 2 hour run limit" });
    // A reason this page has never heard of: the runtime's sentence.
    expect(deliveryView(d({ status: "refused", reason: "fork_head", outcome: "Fork pull requests never start automations." }))).toMatchObject({ tone: "refused", words: "Fork pull requests never start automations." });
  });

  it("keeps a skipped event grey", () => {
    expect(deliveryView(d({ status: "skipped", reason: "skipped_overlap", outcome: "x", event: "schedule" }))).toMatchObject({ tone: "ignored", words: "Skipped: its last run was still going", event: "schedule" });
    expect(deliveryView(d({ status: "skipped", outcome: "Label bug, not caveman." }))).toMatchObject({ tone: "ignored", words: "Skipped" });
  });

  it("reads the older started/refused outcomes and an app-saved webhook's codes", () => {
    expect(deliveryView(d({ outcome: "started r_91" }))).toMatchObject({ tone: "admitted", runId: "r_91" });
    expect(deliveryView(d({ outcome: "refused: policy_denied", error: "From a fork." }))).toMatchObject({ tone: "refused", words: "Refused by a safety rule", detail: "From a fork." });
    expect(deliveryView(d({ outcome: "refused: mystery" }))).toMatchObject({ tone: "refused", words: "Refused" });
    expect(deliveryView(d({ outcome: "accepted" }))).toMatchObject({ tone: "admitted", words: "Started a run" });
    expect(deliveryView(d({ outcome: "rejected_signature" }))).toMatchObject({ tone: "refused", words: "Refused: the signature didn't match" });
    expect(deliveryView(d({ outcome: "filtered", error: "Filter 1 (body.action) did not match." }))).toMatchObject({ tone: "ignored", words: "Skipped by its filters", detail: "Filter 1 (body.action) did not match." });
    expect(deliveryView(d({ outcome: "coalesced" }))).toMatchObject({ tone: "ignored", words: "Folded into a waiting run" });
    expect(deliveryView(d({ outcome: "ignored_label" }))).toMatchObject({ tone: "ignored", words: "Ignored" });
    expect(deliveryView(d({ outcome: "something_new" }))).toMatchObject({ tone: "ignored", words: "Something new" });
  });
});

describe("subjects", () => {
  it("names issues, comments, CI, pushes and the rest", () => {
    expect(subjectView("github:acme/api#12/comment/991")).toEqual({ label: "#12 · comment", repo: "acme/api", url: "https://github.com/acme/api/issues/12#issuecomment-991" });
    expect(subjectView("github:acme/api/actions/ci.yml@main", "CI")).toMatchObject({ label: "ci @ main", title: "CI", url: "https://github.com/acme/api/actions" });
    expect(subjectView("github:acme/api/actions/18334")).toMatchObject({ label: "CI run 18334", url: "https://github.com/acme/api/actions/runs/18334" });
    expect(subjectView("github:acme/api@9e04c1a2b3d4", "Fix the export")).toMatchObject({ label: "9e04c1a", title: "Fix the export" });
    expect(subjectView("manual:01jbx")).toEqual({ label: "By hand" });
    expect(subjectView("github:acme/api#12", undefined, "https://github.com/acme/api/pull/12")).toMatchObject({ url: "https://github.com/acme/api/pull/12" });
  });

  it("leads a run's page with its subject and title, never its id", () => {
    const trigger = { kind: "github" as const, event: "issues.labeled", subject: "github:acme/api#1841", subject_title: "Fix the off-by-one", received_at: "" };
    expect(subjectLine(subjectView(trigger.subject, trigger.subject_title))).toBe("#1841 · Fix the off-by-one");
    expect(runHeading({ automation: "issue-to-pr", trigger })).toBe("#1841 · Fix the off-by-one");
    expect(runHeading({ automation: "issue-to-pr", trigger: { kind: "manual", subject: "manual:01j", received_at: "" } })).toBe("A run by hand");
    expect(runHeading({ automation: "digest", trigger: { kind: "schedule", subject: "schedule:2026-10-20T09:00", received_at: "" } })).toBe("A scheduled run");
    expect(runHeading({ automation: "agent-builder", trigger: { kind: "manual", event: "agent.run", subject: "manual:01j", subject_title: "Add a --json flag", received_at: "" } })).toBe("Add a --json flag");
    expect(runHeading({ automation: "agent-builder", trigger: { kind: "manual", event: "agent.run", subject: "manual:01j", received_at: "" } })).toBe("builder, run by hand");
  });

  it("reads what the person typed as the run's subject", () => {
    expect(subjectFrom("", "acme/api")).toBeNull();
    expect(subjectFrom(" #12 ", "acme/api")).toEqual({ subject: "github:acme/api#12", number: "12" });
    expect(subjectFrom("12", undefined)).toMatchObject({ error: expect.stringContaining("owner/repo#12") });
    expect(subjectFrom("other/repo#7", "acme/api")).toEqual({ subject: "github:other/repo#7", number: "7" });
    expect(subjectFrom("https://github.com/acme/api/pull/31", undefined)).toEqual({ subject: "github:acme/api#31", number: "31" });
    expect(subjectFrom("twelve", "acme/api")).toMatchObject({ error: expect.any(String) });
  });

  it("shows a manual run's inputs when the runtime sends them", () => {
    expect(inputsWord({ kind: "manual", subject: "manual:x", inputs: { issue: "1850", tone: "" } })).toBe("issue=1850");
    expect(inputsWord({ kind: "manual", subject: "manual:x" })).toBeNull();
  });
});

describe("warnings vs errors", () => {
  it("only errors block a run; warnings are counted apart", () => {
    expect(problemsOf(file({ diagnostics: 3, errors: 1 }))).toEqual({ errors: 1, warnings: 2 });
    expect(canRun(file({ diagnostics: 2, errors: 0 }))).toBe(true);
    expect(canRun(file({ diagnostics: 2, errors: 1 }))).toBe(false);
    // A runtime that predates `errors` counts every problem as one, as it refuses them.
    expect(problemsOf(file({ diagnostics: 2 }))).toEqual({ errors: 2, warnings: 0 });
    expect(countsWord({ errors: 0, warnings: 2 })).toBe("2 warnings");
    expect(countsWord({ errors: 1, warnings: 1 })).toBe("1 error, 1 warning");
  });

  it("filters Has errors by errors only", () => {
    const list = [file({ id: "file:p:project:a", title: "a", diagnostics: 2, errors: 0 }), file({ id: "file:p:project:b", title: "b", diagnostics: 1, errors: 1 })];
    expect(filterAutomations(list, { ...NO_FILTER, states: ["errors"] }, () => undefined).map((a) => a.title)).toEqual(["b"]);
  });

  it("asks first when it takes inputs or a subject", () => {
    expect(needsForm(file())).toBe(false);
    expect(needsForm(file({ inputs: [{ name: "issue", required: true }] }))).toBe(true);
    expect(needsForm(file({ takes_subject: "issue" }))).toBe(true);
  });
});

describe("triggers off", () => {
  const now = new Date(2026, 9, 20, 12, 0).getTime();

  it("says why an on automation's triggers don't fire, instead of looking on", () => {
    const why = "Sign in to GitHub in Settings > Accounts.";
    expect(triggersOff(file({ triggers_off_reason: why }))).toEqual({ label: "Triggers off", reason: why });
    expect(lastRunView(file({ triggers_off_reason: why, last_run_at: new Date(now - 3_600_000).toISOString() }), now)).toEqual({ kind: "off", text: "Triggers off", title: why });
    // Off is off: the switch says so.
    expect(triggersOff(file({ enabled: false, triggers_off_reason: why }))).toBeNull();
    expect(filterAutomations([file({ triggers_off_reason: why })], { ...NO_FILTER, states: ["triggers_off"] }, () => undefined)).toHaveLength(1);
  });

  it("names the default branch a Project file is not on yet", () => {
    expect(triggersOff(file({ on_default_branch: false, default_branch: "trunk" }))).toEqual({ label: "Not on trunk", reason: expect.stringContaining("from trunk only") });
    // Its own sentence, whatever the runtime's says (that one would only say "not on main" again).
    expect(triggersOff(file({ on_default_branch: false, triggers_off_reason: "Not on main yet." }))).toEqual({ label: "Not on main", reason: "Project files trigger from main only. Merge this one to turn its triggers on." });
  });

  it("never says triggers off for one that only runs by hand", () => {
    const manual = file({ trigger: { type: "file", kinds: ["manual"], words: ["By hand"] }, on_default_branch: false, triggers_off_reason: "x", last_run_at: new Date(now - 600_000).toISOString() });
    expect(triggersOff(manual)).toBeNull();
    expect(lastRunView(manual, now)).toEqual({ kind: "ago", text: "10m ago" });
  });

  it("says when a schedule runs next on its own, naming this computer's zone only beside another zone's schedule", () => {
    const at = new Date(2026, 9, 26, 9, 0);
    const day = at.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }).replace(/,/g, "");
    expect(nextRunWord(at, undefined, "Europe/Amsterdam")).toBe(`Next run ${day}, ${clock(9, 0)}`);
    expect(nextRunWord(at, "Europe/Amsterdam", "Europe/Amsterdam")).toBe(`Next run ${day}, ${clock(9, 0)}`);
    expect(nextRunWord(at, "Asia/Tokyo", "Europe/Amsterdam")).toMatch(new RegExp(`^Next run ${day}, ${clock(9, 0)} \\S+$`));
    // The list says when it starts, not when next: that is the trigger's own line on its page.
    expect(lastRunView(file({ next_run_at: at.toISOString() }), now)).toEqual({ kind: "ago", text: "—" });
    expect(lastRunView(file({ runs_running: 1 }), now)).toEqual({ kind: "running", text: "Running" });
  });
});

describe("notices", () => {
  it("says which file took a new name", () => {
    expect(renamedWords(undefined)).toBeNull();
    expect(renamedWords([{ from: ".caveman/automations/pr-review.yaml", to: ".caveman/automations/pr-review-2.yaml" }])).toBe("pr-review.yaml was taken, so this one is pr-review-2.yaml.");
    expect(renamedWords([{ from: "a/x.yaml", to: "a/x-2.yaml" }, { from: "b/r.md", to: "b/r-2.md" }])).toBe("Some names were taken, so these got new ones: x-2.yaml, r-2.md.");
  });

  it("says what deleting a Project file does to main's copy", () => {
    expect(deleteWords(file({ path: ".caveman/automations/issue-to-pr.yaml" })).done).toBe("Deleted here. main's copy stays until you merge the deletion.");
    expect(deleteWords(file({ path: ".caveman/automations/x.yaml", on_default_branch: false })).done).toBe("Deleted .caveman/automations/x.yaml.");
    expect(deleteWords(file({ path: ".caveman/local/automations/x.yaml", scope: "me" })).confirm).toBe("This deletes .caveman/local/automations/x.yaml. Its runs stay in the record.");
  });
});

describe("templates", () => {
  const t = (id: string, category: AutomationTemplateSummary["category"], chips: string[] = ["GitHub"]): AutomationTemplateSummary => ({ id, title: id, category, summary: `${id} summary`, chips, scope: "project", host: "this-mac", paths: [], steps: [] });
  const list = [t("changelog", "Chores and reports", ["Schedule"]), t("pr-review", "Review"), t("issue-to-pr", "Issues and PRs"), t("security", "Review")];

  it("offers only categories that have templates, with counts", () => {
    expect(templateTabs(list)).toEqual([
      { value: "all", label: "All", count: 4 },
      { value: "Review", label: "Review", count: 2 },
      { value: "Issues and PRs", label: "Issues and PRs", count: 1 },
      { value: "Chores and reports", label: "Chores and reports", count: 1 },
    ]);
  });

  it("orders by category and searches titles, summaries and chips", () => {
    expect(filterTemplates(list, "all", "").map((x) => x.id)).toEqual(["pr-review", "security", "issue-to-pr", "changelog"]);
    expect(filterTemplates(list, "all", "schedule").map((x) => x.id)).toEqual(["changelog"]);
    expect(filterTemplates(list, "Review", "sec").map((x) => x.id)).toEqual(["security"]);
  });
});

describe("agent run rows", () => {
  it("a review that asked for changes says so instead of Worked", () => {
    expect(agentRunWord({ status: "succeeded", steps: [{ decision: "request_changes" }] })).toBe("Asked for changes");
    expect(agentRunWord({ status: "succeeded", steps: [{ decision: "approve" }] })).toBe("Approved");
    expect(agentRunWord({ status: "succeeded", steps: [{}] })).toBe("Worked");
    expect(agentRunWord({ status: "failed", steps: [{ decision: "approve" }] })).toBe("Failed");
  });
});

describe("a run as its thread", () => {
  it("shows the newest attempt that has a chat; a command step has none", () => {
    const tried: ReadonlyArray<{ n: number; workspace_id?: string }> = [{ n: 1, workspace_id: "w1" }, { n: 2, workspace_id: "w2" }, { n: 3 }];
    expect(threadOf({ attempts: tried })).toEqual({ n: 2, workspace_id: "w2" });
    expect(threadOf({ attempts: tried.slice(2) })).toBeNull();
    expect(threadOf({ attempts: [] })).toBeNull();
  });

  it("says what started it in a few words", () => {
    const at = { received_at: "2026-10-27T09:00:00Z" };
    expect(runWho({ automation: "readme-check", trigger: { kind: "manual", subject: "manual", ...at } })).toBe("By hand");
    expect(runWho({ automation: "agent-reviewer", trigger: { kind: "manual", subject: "manual", ...at } })).toBe("Agent run");
    expect(runWho({ automation: "digest", trigger: { kind: "schedule", subject: "schedule:2026-10-27T09:00", ...at } })).toBe("On schedule");
    expect(runWho({ automation: "pr-review", trigger: { kind: "github", event: "pull_request.opened", subject: "github:acme/api#12", subject_title: "Fix the retry", ...at } })).toBe("#12 · Fix the retry");
  });

  it("reads a schedule's own zone from the runtime's words", () => {
    expect(scheduleZoneOf({ type: "file", kinds: ["manual", "schedule"], words: ["Weekdays at 09:00 (Europe/Amsterdam)", "By hand"] })).toBe("Europe/Amsterdam");
    expect(scheduleZoneOf({ type: "file", kinds: ["manual", "schedule"], words: ["Every 1h"] })).toBeUndefined();
    expect(scheduleZoneOf({ type: "daily", time: "09:00" })).toBeUndefined();
  });
});
