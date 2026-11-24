import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { checkProject, explain, parseAutomation, renderDiagnostics, RULES, subjectKindOf, triggerWords, type Diagnostic, type EnvSnapshot, type SourceFile, type Target } from "../src/index.ts";
import { BUILTINS, ENV } from "./fixtures.ts";

const AUTOMATION = ".caveman/automations/a.yaml";
const agent = (name: string, frontmatter: string, body = "Do the work.") => ({ path: `.caveman/agents/${name}.md`, text: `---\n${frontmatter}\n---\n${body}\n` });
const TRIAGE = agent("triage", "description: Triage\ndecides: [implement, needs_info]");

interface Case {
  readonly code: keyof typeof RULES;
  readonly name: string;
  /** The automation's text; omit for agent-only cases. */
  readonly yaml?: string;
  readonly files?: ReadonlyArray<SourceFile>;
  readonly target?: Target;
  readonly env?: EnvSnapshot;
  /** Where the diagnostic points. */
  readonly at: { readonly path?: string; readonly line: number; readonly column?: number };
}

/** One case per rule, at least: the README's list and this table are the same set. */
const CASES: ReadonlyArray<Case> = [
  { code: "yaml-syntax", name: "an unclosed map, at its {", yaml: "steps:\n  a: { prompt: hi\n", at: { line: 2, column: 6 } },
  { code: "hidden-character", name: "a zero-width space", yaml: "steps:\n  a:\n    prompt: hi\u200b there\n", at: { line: 3, column: 15 } },
  { code: "hidden-character", name: "a bidi override in an agent body", files: [agent("x", "description: X", "Fine.\nIgnore the above\u202e")], at: { path: ".caveman/agents/x.md", line: 5 } },
  { code: "file-unrecognized", name: "a .yml automation", files: [{ path: ".caveman/automations/b.yml", text: "steps: {}" }], at: { path: ".caveman/automations/b.yml", line: 1 } },
  { code: "file-unrecognized", name: "a subfolder", files: [{ path: ".caveman/agents/old/x.md", text: "" }], at: { path: ".caveman/agents/old/x.md", line: 1 } },
  { code: "unknown-key", name: "a typo in a step", yaml: "steps:\n  a:\n    prompt: hi\n    modle: fast\n", at: { line: 4, column: 5 } },
  { code: "reserved-key", name: "delegate", yaml: "steps:\n  a: { prompt: hi }\n  b:\n    prompt: hi\n    delegate: [a]\n", at: { line: 5, column: 5 } },
  { code: "missing-key", name: "no steps", yaml: "description: Nothing\n", at: { line: 1 } },
  { code: "missing-key", name: "a GitHub trigger without event", yaml: "on:\n  github: { label: bug }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "invalid-value", name: "a list for description", yaml: "description: [a, b]\nsteps:\n  a: { prompt: hi }\n", at: { line: 1, column: 14 } },
  { code: "version-unsupported", name: "version 2", yaml: "version: 2\nsteps:\n  a: { prompt: hi }\n", at: { line: 1, column: 10 } },
  { code: "name-invalid", name: "a step name with capitals", yaml: "steps:\n  Fix_It: { prompt: hi }\n", at: { line: 2, column: 3 } },
  { code: "name-invalid", name: "a step name with two _ in a row (Cloud splits <automation>__<step>)", yaml: "steps:\n  fix__it: { prompt: hi }\n", at: { line: 2, column: 3 } },
  { code: "name-invalid", name: "a file name with capitals", files: [{ path: ".caveman/automations/My_Thing.yaml", text: "steps:\n  a: { prompt: hi }\n" }], at: { path: ".caveman/automations/My_Thing.yaml", line: 1 } },
  { code: "steps-empty", name: "an empty steps map", yaml: "steps: {}\n", at: { line: 1 } },
  { code: "step-agent-or-prompt", name: "both agent and prompt", yaml: "steps:\n  a:\n    agent: builder\n    prompt: hi\n", at: { line: 2 } },
  { code: "step-agent-or-prompt", name: "an empty step", yaml: "steps:\n  a:\n", at: { line: 2, column: 3 } },
  { code: "step-agent-or-prompt", name: "a run step that also has a prompt", yaml: "steps:\n  a:\n    run: make\n    prompt: hi\n", at: { line: 2, column: 3 } },
  { code: "step-key-unused", name: "a model on a run step", yaml: "steps:\n  a:\n    run: make build\n    model: fast\n", at: { line: 4, column: 5 } },
  { code: "step-key-unused", name: "checks on a wait step", yaml: "steps:\n  a:\n    wait: 1h\n    checks: [make]\n", at: { line: 4, column: 5 } },
  {
    code: "if-not-a-need",
    name: "in a graph, if on a step that is not a need",
    files: [TRIAGE],
    yaml: "steps:\n  triage: { agent: triage }\n  other: { prompt: hi }\n  b:\n    needs: [other]\n    if: { triage: implement }\n    prompt: hi\n",
    at: { line: 6, column: 11 },
  },
  {
    code: "if-failed-never-runs",
    name: "a failure handler behind a step that needs the failed one",
    yaml: "steps:\n  build: { prompt: build it }\n  test:\n    needs: [build]\n    prompt: test it\n  notify:\n    needs: [test]\n    if: { build: failed }\n    prompt: tell the team\n",
    at: { line: 8, column: 11 },
  },
  { code: "needs-unknown-step", name: "needs on a missing step", yaml: "steps:\n  a: { prompt: hi }\n  b:\n    needs: [c]\n    prompt: hi\n", at: { line: 4, column: 12 } },
  { code: "needs-unknown-step", name: "a step that needs itself", yaml: "steps:\n  a:\n    needs: [a]\n    prompt: hi\n", at: { line: 3, column: 12 } },
  { code: "needs-cycle", name: "two steps that need each other", yaml: "steps:\n  a:\n    needs: [b]\n    prompt: hi\n  b:\n    needs: [a]\n    prompt: hi\n", at: { line: 3, column: 5 } },
  { code: "agent-unknown", name: "a typo in an agent name", yaml: "steps:\n  a:\n    agent: buidler\n", at: { line: 3, column: 12 } },
  { code: "if-unknown-step", name: "if on a missing step", files: [TRIAGE], yaml: "steps:\n  triage: { agent: triage }\n  b:\n    if: { triag: implement }\n    prompt: hi\n", at: { line: 4, column: 11 } },
  { code: "if-not-earlier", name: "if on a later step", files: [TRIAGE], yaml: "steps:\n  b:\n    if: { triage: implement }\n    prompt: hi\n  triage: { agent: triage }\n", at: { line: 3 } },
  { code: "if-unknown-value", name: "if on a value triage does not decide", files: [TRIAGE], yaml: "steps:\n  triage: { agent: triage }\n  b:\n    if: { triage: implment }\n    prompt: hi\n", at: { line: 4, column: 19 } },
  { code: "if-no-decides", name: "if on a decision of an agent without decides", yaml: "steps:\n  build: { agent: builder }\n  b:\n    if: { build: done }\n    prompt: hi\n", at: { line: 4 } },
  { code: "step-decides-agent", name: "decides on a step with an agent", yaml: "steps:\n  a:\n    agent: builder\n    decides: [ship, hold]\n", at: { line: 4, column: 5 } },
  { code: "model-invalid", name: "a model with no provider", yaml: "steps:\n  a: { prompt: hi, model: gpt5 }\n", at: { line: 2, column: 27 } },
  { code: "model-alias", name: "a Claude alias", yaml: "steps:\n  a: { prompt: hi, model: haiku }\n", at: { line: 2 } },
  { code: "model-auto-no-computer", name: "auto with no checkout", yaml: "steps:\n  a: { prompt: hi, model: auto, computer: none }\n", at: { line: 2 } },
  { code: "effort-invalid", name: "an effort level that does not exist", yaml: "steps:\n  a: { prompt: hi, effort: extreme }\n", at: { line: 2 } },
  { code: "escalate-not-class", name: "escalate to a model", yaml: "steps:\n  a: { prompt: hi, escalate: opus, retries: 1 }\n", at: { line: 2 } },
  { code: "escalate-not-class", name: "a ladder rung that is a word", yaml: "steps:\n  a:\n    prompt: hi\n    retries: 2\n    escalate: [frontier]\n", at: { line: 5 } },
  { code: "escalate-without-retries", name: "escalate with no retries", yaml: "steps:\n  a: { prompt: hi, escalate: frontier }\n", at: { line: 2 } },
  { code: "computer-invalid", name: "a typo in computer", yaml: "steps:\n  a:\n    prompt: hi\n    computer: ful\n", at: { line: 4, column: 15 } },
  { code: "retries-range", name: "five retries", yaml: "steps:\n  a: { prompt: hi, retries: 5 }\n", at: { line: 2 } },
  { code: "timeout-invalid", name: "a timeout in words", yaml: "steps:\n  a: { prompt: hi, timeout: 30 minutes }\n", at: { line: 2 } },
  { code: "timeout-too-long", name: "a three-hour timeout, past the run's 2h deadline", yaml: "steps:\n  a: { prompt: hi, timeout: 3h }\n", at: { line: 2 } },
  { code: "check-invalid", name: "a number as a check", yaml: "steps:\n  a:\n    prompt: hi\n    checks: [3]\n", at: { line: 4 } },
  { code: "checks-need-computer", name: "a command check with no checkout", yaml: "steps:\n  a:\n    prompt: hi\n    computer: none\n    checks: [pnpm test]\n", at: { line: 4 } },
  { code: "check-agent-decides", name: "an agent check that does not review", yaml: "steps:\n  a:\n    prompt: hi\n    checks: [{ agent: builder }]\n", at: { line: 4 } },
  { code: "parallel-range", name: "nine at once", yaml: "steps:\n  a:\n    prompt: hi\n    parallel: 9\n    checks: [make]\n", at: { line: 4, column: 15 } },
  { code: "parallel-needs-check", name: "parallel with nothing to tell attempts apart", yaml: "steps:\n  a:\n    prompt: hi\n    parallel: 2\n", at: { line: 4, column: 5 } },
  { code: "pick-without-parallel", name: "pick on one attempt", yaml: "steps:\n  a:\n    prompt: hi\n    pick: best\n", at: { line: 4, column: 5 } },
  { code: "approve-timeout-too-long", name: "a three-week approval", yaml: "steps:\n  a:\n    prompt: hi\n    approve: { by: owner, timeout: 504h }\n", at: { line: 4, column: 36 } },
  { code: "wait-invalid", name: "a wait longer than a week", yaml: "steps:\n  a:\n    wait: 200h\n", at: { line: 3, column: 11 } },
  { code: "wait-invalid", name: "a wait in days", yaml: "steps:\n  a:\n    wait: 2d\n", at: { line: 3, column: 11 } },
  { code: "outcome-iterations-range", name: "nine iterations", yaml: "steps:\n  a:\n    prompt: hi\n    outcome: { rubric: tests pass, max_iterations: 9 }\n", at: { line: 4, column: 52 } },
  { code: "outcome-not-agent", name: "a rubric on a command", yaml: "steps:\n  a:\n    run: make\n    outcome: { rubric: it builds }\n", at: { line: 4, column: 5 } },
  { code: "engine-unknown", name: "a ladder rung on claude-code", yaml: "steps:\n  a:\n    prompt: hi\n    retries: 2\n    escalate: [{ model: frontier }, { engine: claude-code }]\n", at: { line: 5, column: 47 } },
  { code: "engine-unavailable", name: "a step on an engine that is signed out", env: ENV, files: [agent("coder", "description: C\nengine: codex")], yaml: "steps:\n  a: { agent: coder }\n", at: { line: 2 } },
  { code: "github-event-unknown", name: "a typo in an event", yaml: "on:\n  github: { event: issues.labled }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2, column: 20 } },
  { code: "github-filter-mismatch", name: "paths on issues", yaml: "on:\n  github: { event: issues.labeled, paths: [src/**] }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "github-label-never-matches", name: "label with push", yaml: "on:\n  github: { event: [issues.labeled, push], label: caveman }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "github-actors-any", name: "actors: any in Caveman Code", yaml: "on:\n  github: { event: issues.opened, actors: any }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "github-actors-invalid", name: "an actor that is not an association", yaml: "on:\n  github: { event: issues.opened, actors: [everyone] }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "schedule-shape", name: "at and every", yaml: "on:\n  schedule: { at: \"09:00\", timezone: UTC, every: 6h }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "schedule-at-invalid", name: "a one-digit hour", yaml: "on:\n  schedule: { at: 9:00, timezone: UTC }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "schedule-timezone-missing", name: "at without timezone", yaml: "on:\n  schedule: { at: \"09:00\" }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "schedule-timezone-invalid", name: "a misspelt zone", yaml: "on:\n  schedule: { at: \"09:00\", timezone: Europe/Amsterdm }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "schedule-every-invalid", name: "every minute", yaml: "on:\n  schedule: { every: 1m }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "schedule-weekdays-invalid", name: "a day in full", yaml: "on:\n  schedule: { at: \"09:00\", timezone: UTC, weekdays: [monday] }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "schedule-monthdays-invalid", name: "the 32nd", yaml: "on:\n  schedule: { at: \"09:00\", timezone: UTC, monthdays: [32] }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "schedule-date-invalid", name: "the 30th of February", yaml: "on:\n  schedule: { once: \"2027-02-30 09:00\", timezone: UTC }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "schedule-date-invalid", name: "once without a time", yaml: "on:\n  schedule: { once: \"2027-02-03\", timezone: UTC }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "schedule-start-missing", name: "every other week from nowhere", yaml: "on:\n  schedule: { at: \"09:00\", timezone: UTC, weekdays: [mon], every: 2w }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "schedule-cron-invalid", name: "an hour past 23", yaml: "on:\n  schedule: { cron: \"0 25 * * *\", timezone: UTC }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "schedule-count-invalid", name: "no runs at all", yaml: "on:\n  schedule: { every: 6h, count: 0 }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "trigger-needs-cloud", name: "Slack on This Mac", yaml: "on:\n  slack: { mention: true }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2, column: 3 } },
  { code: "trigger-needs-cloud", name: "a GitHub event only Cloud hears, on This Mac", yaml: "on:\n  github: { event: pull_request.closed, merged: true }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2, column: 20 } },
  { code: "host-me-cloud", name: "a Me file for Cloud", files: [{ path: ".caveman/local/automations/b.yaml", text: "host: cloud\nsteps:\n  a: { prompt: hi }\n" }], at: { path: ".caveman/local/automations/b.yaml", line: 1, column: 7 } },
  { code: "webhook-not-served", name: "a webhook in Caveman Code", yaml: "on:\n  webhook: {}\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "trigger-not-served", name: "a schedule where none are served", target: "ci", env: { ...ENV, servedTriggers: ["manual"] }, yaml: "on:\n  schedule: { every: 6h }\nsteps:\n  a: { prompt: hi }\n", at: { line: 2 } },
  { code: "budget-invalid", name: "zero dollars", yaml: "budget: $0\nsteps:\n  a: { prompt: hi }\n", at: { line: 1 } },
  { code: "budget-invalid", name: "dollars in words", yaml: "budget: 6 dollars\nsteps:\n  a: { prompt: hi }\n", at: { line: 1, column: 9 } },
  { code: "output-invalid", name: "a step without a field", yaml: "on:\n  github: { event: issues.opened }\nsteps:\n  a: { prompt: hi }\noutputs:\n  github.comment: a\n", at: { line: 6 } },
  { code: "output-unknown-step", name: "an output from a missing step", yaml: "on:\n  github: { event: issues.opened }\nsteps:\n  a: { prompt: hi }\noutputs:\n  github.comment: b.summary\n", at: { line: 6 } },
  { code: "output-unknown-field", name: "a field the agent does not return", yaml: "on:\n  github: { event: issues.opened }\nsteps:\n  a: { prompt: hi }\noutputs:\n  github.comment: a.verdict\n", at: { line: 6 } },
  { code: "pull-request-needs-full", name: "a pull request from a readonly step", yaml: "steps:\n  a: { agent: builder }\noutputs:\n  github.pull_request: { from: a }\n", at: { line: 4 } },
  { code: "output-needs-cloud", name: "a Slack message from This Mac", yaml: "steps:\n  a: { prompt: hi }\noutputs:\n  slack.message: { from: a, channel: \"#ops\" }\n", at: { line: 4, column: 3 } },
  { code: "outsider-approval", name: "a Slack mention whose answer goes to another channel: its step waits for the owner first", yaml: "host: cloud\non:\n  slack: { mention: true }\nsteps:\n  look: { prompt: look }\n  answer: { prompt: hi }\noutputs:\n  slack.message: { from: answer, channel: \"#ops\" }\n", at: { line: 3, column: 3 } },
  { code: "output-needs-trigger", name: "a Linear comment with no Linear trigger", yaml: "host: cloud\nsteps:\n  a: { prompt: hi }\noutputs:\n  linear.comment: a.summary\n", at: { line: 5, column: 3 } },
  { code: "comment-needs-github", name: "a comment with no GitHub trigger", yaml: "steps:\n  a: { prompt: hi }\noutputs:\n  github.comment: a.summary\n", at: { line: 4, column: 3 } },
  { code: "chief-never-news", name: "a routine whose step never decides news", yaml: "steps:\n  look: { run: ./check.sh }\noutputs:\n  chief: { from: look }\n", at: { line: 4, column: 3 } },
  { code: "agent-name-invalid", name: "a name with a space", files: [agent("x", "name: bad name")], at: { path: ".caveman/agents/x.md", line: 2 } },
  { code: "agent-unknown-key", name: "a typo in decides", files: [agent("x", "description: X\ndecide: [a]")], at: { path: ".caveman/agents/x.md", line: 3 } },
  { code: "agent-key-not-applied", name: "secrets", files: [agent("x", "description: X\nsecrets: [SENTRY_TOKEN]")], at: { path: ".caveman/agents/x.md", line: 3 } },
  { code: "agent-effort-unknown", name: "an effort Caveman does not know", files: [agent("x", "description: X\neffort: ultra")], at: { path: ".caveman/agents/x.md", line: 3, column: 9 } },
  { code: "agent-role-unknown", name: "an unknown role", files: [agent("x", "role: boss")], at: { path: ".caveman/agents/x.md", line: 2 } },
  { code: "custom-tool-invalid", name: "a custom tool named like an MCP tool", files: [agent("x", "description: X\ntools:\n  - type: custom\n    name: mcp__orders")], at: { path: ".caveman/agents/x.md", line: 4 } },
  { code: "agent-computer-invalid", name: "a typo in an agent's computer", files: [agent("x", "description: X\ncomputer: nonee")], at: { path: ".caveman/agents/x.md", line: 3 } },
  { code: "mcp-server-invalid", name: "an MCP server with neither a command nor a url", files: [agent("x", "description: X\nmcpServers:\n  docs: { type: http }")], at: { path: ".caveman/agents/x.md", line: 4 } },
  { code: "engine-unknown", name: "claude-code", files: [agent("x", "engine: claude-code")], at: { path: ".caveman/agents/x.md", line: 2, column: 9 } },
  { code: "decides-invalid", name: "a value with capitals", files: [agent("x", "decides: [Ship, hold]")], at: { path: ".caveman/agents/x.md", line: 2 } },
  { code: "decides-reserved", name: "failed", files: [agent("x", "decides: [ok, failed]")], at: { path: ".caveman/agents/x.md", line: 2 } },
  { code: "returns-missing", name: "a schema that is not there", files: [agent("x", "description: X\nreturns: x.schema.json")], at: { path: ".caveman/agents/x.md", line: 3 } },
  {
    code: "returns-invalid",
    name: "a schema with no properties",
    files: [agent("x", "description: X\nreturns: x.schema.json"), { path: ".caveman/agents/x.schema.json", text: '{"type":"string"}' }],
    at: { path: ".caveman/agents/x.md", line: 3 },
  },
];

const run = (c: Pick<Case, "yaml" | "files" | "target" | "env">) =>
  checkProject({
    files: [...(c.yaml === undefined ? [] : [{ path: AUTOMATION, text: c.yaml }]), ...(c.files ?? [])],
    agents: BUILTINS,
    ...(c.target ? { target: c.target } : {}),
    ...(c.env ? { env: c.env } : {}),
  });

describe("schedules", () => {
  const diagnostics = (schedule: string) => run({ yaml: `on:\n  schedule: ${schedule}\nsteps:\n  a: { prompt: hi }\n` }).diagnostics.map((d) => [d.code, d.message]);

  test.each([
    '{ once: "2026-11-09 09:00", timezone: Europe/Amsterdam }',
    '{ once: "2026-11-09T09:00", timezone: Europe/Amsterdam }',
    '{ at: "09:00", timezone: UTC, monthdays: [1, 15, last] }',
    '{ at: "09:00", timezone: UTC, every: 3d, start: "2026-11-09" }',
    '{ at: "09:00", timezone: UTC, weekdays: [mon, thu], every: 2w, start: "2026-11-09" }',
    '{ at: "09:00", timezone: UTC, weekdays: [mon], every: 1w }',
    '{ cron: "0 9 * * 1-5", timezone: America/New_York }',
    '{ cron: "0 9 L * *", timezone: UTC, until: "2027-06-30" }',
    '{ every: 6h, start: "2026-11-09", until: "2026-12-31", count: 10, timezone: UTC }',
    '{ every: 6h, count: 3 }',
    '{ at: "09:00", timezone: UTC, start: "2026-11-09", until: "2026-11-09" }',
  ])("%s is a schedule", (schedule) => {
    expect(diagnostics(schedule)).toEqual([]);
  });

  test.each([
    ['{ at: "09:00", once: "2026-11-09 09:00", timezone: UTC }', "schedule-shape", "this one has at and once"],
    ['{ cron: "0 9 * * *", every: 6h, timezone: UTC }', "schedule-shape", "this one has every and cron"],
    ['{ at: "09:00", every: 6h, timezone: UTC }', "schedule-shape", "every 6h is an interval"],
    ['{ at: "09:00", timezone: UTC, weekdays: [mon], monthdays: [1] }', "schedule-shape", "weekdays or on monthdays, not both"],
    ['{ monthdays: [1], every: 6h }', "schedule-shape", "monthdays goes with at"],
    ['{ at: "09:00", timezone: UTC, every: 2d, weekdays: [mon], start: "2026-11-09" }', "schedule-shape", "takes no weekdays"],
    ['{ at: "09:00", timezone: UTC, every: 2w, start: "2026-11-09" }', "schedule-shape", "add them, like weekdays: [mon]"],
    ['{ once: "2026-11-09 09:00", timezone: UTC, count: 2 }', "schedule-shape", "once runs one time, so it takes no count"],
    ['{ once: "2026-11-09 09:00" }', "schedule-timezone-missing", "Add timezone"],
    ['{ cron: "0 9 * * *" }', "schedule-timezone-missing", "Add timezone"],
    ['{ every: 6h, start: "2026-11-09" }', "schedule-timezone-missing", "Add timezone"],
    ['{ every: 6h, timezone: UTC, start: "2026-11-09", until: "2026-11-01" }', "schedule-date-invalid", "before start"],
    ['{ every: 2w }', "schedule-every-invalid", "add at: \"09:00\" with weekdays: [mon]"],
  ])("%s is refused", (schedule, code, words) => {
    const found = diagnostics(schedule);
    expect(found.map(([c]) => c), JSON.stringify(found)).toContain(code);
    expect(found.find(([c]) => c === code)![1]).toContain(words);
  });
});

describe("every rule fires where the problem is", () => {
  test.each(CASES)("$code: $name", (c) => {
    const found = run(c).diagnostics.filter((d) => d.code === c.code);
    expect(found.length, JSON.stringify(run(c).diagnostics, null, 2)).toBeGreaterThan(0);
    const d = found[0]!;
    expect(d.path).toBe(c.at.path ?? AUTOMATION);
    expect(d.line).toBe(c.at.line);
    if (c.at.column !== undefined) expect(d.column).toBe(c.at.column);
    expect(d.severity).toBe(RULES[c.code].severity);
    // One sentence or two that end properly, and never a stack of Effect jargon.
    expect(d.message).toMatch(/[.?]$/);
    expect(d.message).not.toMatch(/Expected|undefined|\[object/);
  });

  test("the table covers every rule, and the README lists every rule", () => {
    expect(new Set(CASES.map((c) => c.code))).toEqual(new Set(Object.keys(RULES)));
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    for (const code of Object.keys(RULES)) expect(readme, code).toContain(`\`${code}\``);
  });
});

describe("messages people act on", () => {
  const messages = (c: Pick<Case, "yaml" | "files" | "target" | "env">) => run(c).diagnostics.map((d: Diagnostic) => d.message);

  test("did you mean, across keys, events, agents, decisions and zones", () => {
    expect(messages({ yaml: "steps:\n  a:\n    prompt: hi\n    modle: fast\n" })).toContain('Unknown key "modle" in step "a". Did you mean "model"?');
    expect(messages({ yaml: "steps:\n  a:\n    agent: buidler\n" })[0]).toBe('No agent "buidler". Did you mean "builder"?');
    expect(messages({ files: [TRIAGE], yaml: "steps:\n  triage: { agent: triage }\n  b:\n    if: { triage: implment }\n    prompt: hi\n" })).toContain(
      'if: { triage: implment }: "triage" decides implement or needs_info, or failed. Did you mean "implement"?',
    );
    expect(messages({ yaml: "on:\n  schedule: { at: \"09:00\", timezone: Europe/Amsterdm }\nsteps:\n  a: { prompt: hi }\n" })[0]).toContain('Did you mean "Europe/Amsterdam"?');
    expect(messages({ files: [agent("x", "engine: claude-code")] })).toContain('engine "claude-code" is not an engine. Use "claude-agent".');
  });

  test("an unknown agent with no close match lists the ones that exist", () => {
    expect(messages({ yaml: "steps:\n  a: { agent: deployer }\n" })[0]).toBe(
      'No agent "deployer". Add .caveman/agents/deployer.md, or use one of investigator, builder, reviewer, tester or scout.',
    );
  });

  test("a typo'd key does not also report the key it was meant to be", () => {
    const found = run({ yaml: "steps:\n  a:\n    prompt: hi\n    checks: [{ agnt: reviewer }]\n" }).diagnostics;
    expect(found.map((d) => d.code)).toEqual(["unknown-key"]);
  });

  test("reserved keys say what to do in v1", () => {
    expect(messages({ yaml: "steps:\n  a:\n    prompt: hi\n    budget: $1\n" })[0]).toBe(
      '"budget" in step "a" is coming in a later version. For now, budget is set once for the whole run, at the top of the file.',
    );
    expect(messages({ yaml: "on:\n  manual: true\nsteps:\n  a: { prompt: hi }\n" })[0]).toBe('Unknown key "manual" in on. Running by hand always works; remove manual.');
  });

  test("everything wrong in one pass, without errors that only follow from another", () => {
    const yaml = [
      "on:",
      "  github: { event: issues.opened }",
      "steps:",
      "  build:",
      "    agent: builder",
      "    computer: ful",
      "    retries: 9",
      "  review:",
      "    agent: reviewr",
      "outputs:",
      "  github.pull_request: { from: build }",
      "  github.comment: build.answer",
    ].join("\n");
    const found = run({ yaml });
    expect(found.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ["computer-invalid", 6],
      ["retries-range", 7],
      ["agent-unknown", 9],
      ["output-unknown-field", 12],
    ]);
    // computer: ful is not reported again as "build is computer: readonly", and the file does not load.
    expect(found.automations).toEqual([]);
  });

  test("actors: any is allowed in CI, and Me files always run in Caveman Code", () => {
    const yaml = "on:\n  github: { event: issues.opened, actors: any }\nsteps:\n  a: { prompt: hi }\n";
    expect(run({ yaml, target: "ci" }).diagnostics).toEqual([]);
    const me = checkProject({ files: [{ path: ".caveman/local/automations/a.yaml", text: yaml }], agents: BUILTINS, target: "ci" });
    expect(me.diagnostics.map((d) => d.code)).toEqual(["github-actors-any"]);
  });

  test("a step can test failed on any earlier step, and an agent check passes with a reviewing agent", () => {
    const yaml = [
      "steps:",
      "  build:",
      "    agent: builder",
      "    computer: full",
      "    checks: [pnpm test, { agent: reviewer }]",
      "    retries: 2",
      "    escalate: frontier",
      "  report:",
      "    if: { build: failed }",
      "    prompt: Say what broke.",
      "    model: fast",
      "    computer: none",
    ].join("\n");
    expect(run({ yaml }).diagnostics).toEqual([]);
  });

  test("outputs read fields the agent's returns schema declares", () => {
    const files = [
      agent("risk", "description: Rates risk\nreturns: risk.schema.json"),
      { path: ".caveman/agents/risk.schema.json", text: JSON.stringify({ type: "object", properties: { risk: { type: "string" } } }) },
    ];
    const ok = "on:\n  github: { event: pull_request.opened }\nsteps:\n  r: { agent: risk }\noutputs:\n  github.comment: r.risk\n";
    expect(run({ yaml: ok, files }).diagnostics).toEqual([]);
    expect(messages({ yaml: ok.replace("r.risk", "r.rsk"), files })[0]).toBe('github.comment reads r.rsk, and "r" returns summary or risk. Did you mean "risk"?');
  });

  test("a schema file no agent names is reported, not skipped", () => {
    const found = run({ files: [{ path: ".caveman/agents/orphan.json", text: "{}" }] }).diagnostics;
    expect(found.map((d) => [d.code, d.message])).toEqual([["file-unrecognized", "No agent names orphan.json in returns, so it is not read."]]);
  });

  test("project agent files shadow the registry, and the registry keeps its order", () => {
    const result = checkProject({ files: [agent("reviewer", "description: Ours\ndecides: [approve, request_changes]")], agents: BUILTINS });
    expect(result.agents.map((a) => [a.name, a.source])).toEqual([
      ["reviewer", "project"],
      ["investigator", "builtin"],
      ["builder", "builtin"],
      ["tester", "builtin"],
      ["scout", "builtin"],
    ]);
  });

  test("a loaded automation carries its scope, digest and text", () => {
    const text = "steps:\n  a: { prompt: hi }\n";
    const result = checkProject({ files: [{ path: ".caveman/local/automations/mine.yaml", text }], agents: [] });
    expect(result.automations).toEqual([
      { name: "mine", scope: "me", path: ".caveman/local/automations/mine.yaml", file: { steps: { a: { prompt: "hi" } } }, digest: expect.stringMatching(/^[0-9a-f]{64}$/), text },
    ]);
  });
});

describe("YAML mistakes in plain sentences, one per problem (B11)", () => {
  const syntax = (yaml: string) => run({ yaml }).diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`);

  test("a colon in a plain value says to quote it or write a block, and if: a: b says to write a map", () => {
    expect(syntax("steps:\n  review:\n    prompt: End with decision: review\n    model: fast\n")).toEqual([
      '3:5 The value of prompt has ": " in it, which YAML reads as another key. Quote the value, or write it as a block: prompt: | with the text on the lines below.',
    ]);
    expect(syntax("steps:\n  a: { prompt: hi }\n  b:\n    if: gate: review\n    prompt: x\n")).toEqual(["4:5 if takes a map; write it as if: { gate: review }."]);
    expect(syntax("steps:\n  a: { prompt: End with decision: review }\n")).toEqual(['2:16 A value inside { } has ": " in it, which YAML reads as another key; put that value in quotes.']);
  });

  test("a duplicate names the key and the line of the first one", () => {
    expect(syntax("steps:\n  review:\n    agent: reviewer\n  review:\n    agent: builder\n")).toEqual(['4:3 There is already a step named "review" on line 2; give this one another name.']);
    expect(syntax("steps:\n  review:\n    agent: reviewer\n    agent: builder\n")).toEqual(['4:5 "agent" is already set on line 3; keep one of them.']);
    expect(syntax("steps:\n  a: { prompt: hi }\nsteps:\n  b: { prompt: x }\n")).toEqual(['3:1 "steps" is already set on line 1; keep one of them.']);
    expect(syntax("steps:\n  a: { prompt: hi, prompt: ho }\n")).toEqual(['2:20 "prompt" appears twice here; keep one of them.']);
    // The duplicate is the mistake to fix first, before one inside its value.
    expect(syntax("steps:\n  a: 1\n  a: { prompt: x: y }\n")).toEqual(['3:3 There is already a step named "a" on line 2; give this one another name.']);
  });

  test("tabs, over-indents and misaligned dashes each get one line, where the fix goes", () => {
    expect(syntax("steps:\n  review:\n\tagent: reviewer\n")).toEqual(["3:1 Use spaces to indent; this line has a tab."]);
    expect(syntax("steps:\n  review:\n    agent: reviewer\n      model: base\n")).toEqual(["4:7 model is indented further than agent above it; line them up."]);
    expect(syntax("steps:\n  a:\n    prompt: hi\n    checks:\n    - pnpm test\n   - pnpm lint\n")).toEqual(["6:4 This - is not lined up with the - on line 5; give them the same indent."]);
  });

  test("unclosed brackets and quotes point at where they open; reserved first characters say to quote", () => {
    expect(syntax("steps:\n  a:\n    prompt: hi\n    checks: [pnpm test\n")).toEqual(["4:13 This [ is never closed; add the ] that ends it."]);
    expect(syntax("steps:\n  a:\n    prompt: don't stop\n    model: \"fast\n")).toEqual(['4:12 This " is never closed; add a closing " where the value ends.']);
    expect(syntax("steps:\n  a:\n    prompt: @caveman answer\n")).toEqual(['3:13 A value cannot start with @ unless it is quoted; write prompt: "@caveman answer".']);
    expect(syntax("steps:\n  a:\n    prompt: *bold* text\n")).toEqual(['3:5 This value starts with *, which YAML reads as something else; put the whole value in quotes: prompt: "*bold* text".']);
  });

  test("step settings indented too little say which step they belong to, once", () => {
    const found = run({ yaml: "on:\n  github: { event: issues.opened }\nsteps:\n  review:\n  agent: reviewer\n  model: base\noutputs:\n  github.comment: review.summary\n" }).diagnostics;
    expect(found.map((d) => [d.line, d.message])).toEqual([[5, "Indent agent: and model: under review; they are step settings, not steps."]]);
    expect(syntax("steps:\n  review:\n    agent: reviewer\n  model: base\n")).toEqual(["4:3 Indent model: under review; it is a step setting, not a step."]);
    expect(syntax("on:\n  github:\n  event: issues.opened\nsteps:\n  a: { prompt: hi }\n")).toEqual(["3:3 Indent event: under github; it is a github setting, not a key of its own."]);
  });

  test("if written as a comparison shows the map it meant", () => {
    expect(syntax("steps:\n  gate: { prompt: hi, decides: [review, skip] }\n  b:\n    if: gate == review\n    prompt: x\n")).toEqual([
      '4:9 if is "gate == review"; write it as a map of earlier steps and what they decided: if: { gate: review }.',
    ]);
  });
});

describe("a file under the runtime's 1 MiB read cap is checked in time that grows with its size, not its square", () => {
  // The runtime checks every project's files on each scheduler tick, on its one event loop.
  const SMALL = 2_000;
  /** n steps, each needing the one before it. */
  const chain = (n: number, extra: (i: number) => string) =>
    `steps:\n${Array.from({ length: n }, (_, i) => `  s${i}: { prompt: p${i > 0 ? `, needs: [s${i - 1}]` : ""}${extra(i)} }\n`).join("")}`;
  // Windows counts a thread's CPU time in 15.6 ms ticks, and so does a Linux built with tick-based CPU accounting (4 ms
  // at 250 Hz, as on CI's Blacksmith runners): there a check quicker than a tick takes no time at all. So the text is
  // checked until the clock has moved 250 ms, and one check's share is taken.
  const floorMs = 250;
  const cpuMs = (text: string) => {
    const start = process.threadCpuUsage();
    for (let runs = 1; ; runs++) {
      run({ yaml: text });
      const used = process.threadCpuUsage(start);
      const ms = (used.user + used.system) / 1000;
      if (ms >= floorMs) return ms / runs;
    }
  };

  test.each([
    ["a valid map of many keys", (n: number) => Array.from({ length: n }, (_, i) => `k${i}: v\n`).join("")],
    ["a YAML mistake on every line", (n: number) => `steps:\n${Array.from({ length: n }, (_, i) => `  s${i}: { prompt: a: b }\n`).join("")}`],
    ["the same key on every line", (n: number) => `steps:\n${"  a: { prompt: hi }\n".repeat(n)}`],
    ["a mistake in every item of one long line", (n: number) => `steps: { ${Array.from({ length: n }, (_, i) => `s${i}: { prompt: a: b }`).join(", ")} }\n`],
    ["a quote left open on every line", (n: number) => Array.from({ length: n }, (_, i) => `k${i}: "a\n`).join("")],
    ["brackets left open before one long line", (n: number) => `x: ${"{a: ".repeat(n / 40)}${"b, ".repeat(5 * n)}\n`],
    // A graph's needs: an if may test any step its step needs, directly or not, and a failure handler never runs behind
    // a step that the failure skips.
    ["a needs chain with no if", (n: number) => chain(n, () => "")],
    ["a needs chain of failure handlers", (n: number) => chain(n, (i) => (i > 0 ? ", if: { s0: failed }" : ""))],
    ["a needs chain of failure handlers behind a step the failure skips", (n: number) => chain(n, (i) => (i > 1 ? ", if: { s0: failed }" : ""))],
    ["a needs chain whose every step tests a different earlier step's failure", (n: number) => chain(n, (i) => (i > 1 ? `, if: { s${i - 2}: failed }` : ""))],
    ["one step that needs every step of a chain and tests each one's failure", (n: number) => {
      const steps = Array.from({ length: n }, (_, i) => `s${i}`);
      return `${chain(n, () => "")}  h: { prompt: p, needs: [${steps.join(", ")}], if: { ${steps.map((s) => `${s}: failed`).join(", ")} } }\n`;
    }],
    // A problem on every step, each message about the other steps.
    ["a needs chain whose every step tests a step that is not there", (n: number) => chain(n, () => ", if: { nope: failed }")],
    ["a need on every step that is not a step", (n: number) => `steps:\n${Array.from({ length: n }, (_, i) => `  s${i}: { prompt: p, needs: [nope] }\n`).join("")}`],
    ["a rejected value on every step", (n: number) => `steps:\n${Array.from({ length: n }, (_, i) => `  s${i}: { prompt: p, retries: -1 }\n`).join("")}`],
    ["a decision tested on every step that the step it tests does not decide", (n: number) =>
      `steps:\n  a: { prompt: p, decides: [${Array.from({ length: 2 * n }, (_, i) => `d${i}`).join(", ")}] }\n${Array.from({ length: n }, (_, i) => `  s${i}: { prompt: p, if: { a: zz } }\n`).join("")}`],
    ["a long list with every other item rejected", (n: number) => `steps:\n  a: { prompt: p }\n  b: { prompt: p, needs: [${Array.from({ length: 20 * n }, (_, i) => (i % 2 ? "1" : "a")).join(", ")}] }\n`],
  ])("%s", (_, make) => {
    const big = make(8 * SMALL);
    expect(big.length).toBeLessThan(1024 * 1024);
    const small = Math.min(...[0, 1, 2].map(() => cpuMs(make(SMALL))));
    // Eight times the size: about 8 times the time when linear, 64 when quadratic.
    expect(cpuMs(big) / small).toBeLessThan(24);
  }, 600_000);

  test("a failure handler of many steps behind a long run of steps that handle another failure costs about what it costs behind steps it skips", () => {
    // h tests the failure of n steps, each of which skips j, and stands behind a run of n steps after j. Steps that test
    // j: failed are not skipped, so for each of h's refs the warning looks past every one of them to name j.
    const behind = (n: number, value: "failed" | "passed") => {
      const refs = Array.from({ length: n }, (_, i) => `r${i}`);
      return `steps:\n${[
        ...refs.map((r) => `  ${r}: { prompt: p }`),
        `  j: { prompt: p, decides: [passed], needs: [${refs.join(", ")}] }`,
        ...Array.from({ length: n }, (_, i) => `  t${i}: { prompt: p, needs: [${i === 0 ? "j" : `t${i - 1}`}], if: { j: ${value} } }`),
        `  h: { prompt: p, needs: [t${n - 1}], if: { ${refs.map((r) => `${r}: failed`).join(", ")} } }`,
      ].join("\n")}\n`;
    };
    const n = 9_000;
    expect(behind(n, "failed").length).toBeLessThan(1024 * 1024);
    expect(run({ yaml: behind(n, "failed") }).diagnostics.map((d) => d.message)).toEqual(
      Array.from({ length: n }, (_, i) => `"h" never runs when "r${i}" fails: "j" is skipped then, and so is every step after it. Have "h" need "r${i}" instead of "t${n - 1}".`),
    );
    const least = (text: string) => Math.min(...[0, 1, 2].map(() => cpuMs(text)));
    // The two files are the same length. Looking one step at a time for each ref took three times as long or more.
    expect(least(behind(n, "failed")) / least(behind(n, "passed"))).toBeLessThan(2);
  }, 600_000);

  test("a long run of spaces in a line with a mistake costs no more than as many letters", () => {
    const line = (fill: string) => `steps:\n  a:\n    prompt: x${fill.repeat(16 * SMALL)}y: z\n`;
    const least = (text: string) => Math.min(...[0, 1, 2].map(() => cpuMs(text)));
    expect(least(line(" ")) / least(line("x"))).toBeLessThan(8);
  }, 600_000);
});

describe("a file with more problems than a function call takes arguments", () => {
  test("is reported in full, not thrown out of check", () => {
    const lines = 200_000;
    const automation = { path: AUTOMATION, text: `steps:\n  a: { prompt: hi }\n${"#\u200b\n".repeat(lines)}` };
    const agentFile = { path: ".caveman/agents/x.md", text: `---\ndescription: X\n---\n${"\u200b\n".repeat(lines)}` };
    // A ] with no [ before it on each line of an agent's frontmatter: one YAML mistake a line.
    const frontmatter = { path: ".caveman/agents/y.md", text: `---\n${"]\n".repeat(lines)}---\nDo the work.\n` };
    for (const [file, code] of [[automation, "hidden-character"], [agentFile, "hidden-character"], [frontmatter, "yaml-syntax"]] as const) {
      expect(new TextEncoder().encode(file.text).length).toBeLessThan(1024 * 1024);
      const { diagnostics } = checkProject({ files: [file], agents: BUILTINS });
      expect(diagnostics.filter((d) => d.code === code && d.path === file.path)).toHaveLength(lines);
      expect(renderDiagnostics(diagnostics).endsWith(`\n\n${lines} errors`)).toBe(true);
    }
  }, 600_000);
});

describe("no cascades, nothing hidden, better suggestions (B12)", () => {
  const found = (c: Pick<Case, "yaml" | "files" | "target" | "env">) => run(c).diagnostics.map((d) => [d.code, d.message]);

  test("a mistyped agent is reported once, not again as an agent that declares no decides", () => {
    const yaml = "steps:\n  gate: { agent: pr-gat }\n  review:\n    if: { gate: review }\n    agent: reviewer\n";
    expect(found({ yaml, files: [agent("pr-gate", "description: G\ndecides: [review, skip]")] })).toEqual([["agent-unknown", 'No agent "pr-gat". Did you mean "pr-gate"?']]);
  });

  test("an agent file that does not load is reported as that file's problem, not as a missing agent", () => {
    const files = [agent("implementer", "name: implementer bot")];
    expect(found({ yaml: "steps:\n  build: { agent: implementer }\n", files })).toEqual([
      ["agent-name-invalid", 'Agent name "implementer bot" cannot load; use letters, digits, - and _ (at most 64), like code-reviewer.'],
      ["agent-unknown", 'Agent "implementer" is .caveman/agents/implementer.md, which does not load; fix the problem reported there first.'],
    ]);
  });

  test("a bad at and a bad timezone, and a bad every and weekdays, are all reported in one pass", () => {
    expect(found({ yaml: "on:\n  schedule: { at: 9:00, timezone: Europe/Amsterdm }\nsteps:\n  a: { prompt: hi }\n" }).map(([code]) => code)).toEqual([
      "schedule-at-invalid",
      "schedule-timezone-invalid",
    ]);
    expect(found({ yaml: "on:\n  schedule: { every: 1d, weekdays: [mon] }\nsteps:\n  a: { prompt: hi }\n" })).toEqual([
      ["schedule-every-invalid", 'every is "1d"; write 24h for an interval, or add at: "09:00" to run at a time every day.'],
      ["schedule-shape", 'weekdays goes with at; with every, the schedule runs every day. For certain days, use at: "09:00" with weekdays.'],
    ]);
  });

  test("an unknown key in a check does not hide the other checks' problems", () => {
    const yaml = "steps:\n  a:\n    prompt: hi\n    computer: none\n    checks: [pnpm test, { agnt: reviewer }, { agent: builder }]\n";
    expect(found({ yaml }).map(([code]) => code)).toEqual(["unknown-key", "checks-need-computer", "check-agent-decides"]);
  });

  test("a real GitHub event Caveman does not watch says so, instead of suggesting a different event", () => {
    const [[, message]] = found({ yaml: "on:\n  github: { event: pull_request.edited }\nsteps:\n  a: { prompt: hi }\n" }) as [[string, string]];
    expect(message).toBe(
      '"pull_request.edited" is not watched in Caveman Code yet. Watched events: issues.opened, issues.labeled, pull_request.opened, pull_request.synchronize, issue_comment.created, push, workflow_run.completed, pull_request.labeled, pull_request.closed, check_suite.completed.',
    );
    // An event only Caveman Cloud hears is fine there.
    expect(found({ yaml: "host: cloud\non:\n  github: { event: pull_request.closed, merged: true }\nsteps:\n  a: { prompt: hi }\n" })).toEqual([]);
    expect(found({ yaml: "on:\n  github: { event: pull_request }\nsteps:\n  a: { prompt: hi }\n" })[0]![1]).toMatch(/^"pull_request" needs an action, like pull_request.opened, pull_request.synchronize, pull_request.labeled or pull_request.closed\./);
  });

  test("durations and times suggest the fix: 1d is 24h, 9:00 is 09:00", () => {
    expect(found({ yaml: "on:\n  schedule: { every: 1d }\nsteps:\n  a: { prompt: hi }\n" })[0]![1]).toBe('every is "1d"; write 24h for an interval, or add at: "09:00" to run at a time every day.');
    expect(found({ yaml: "steps:\n  a: { prompt: hi, timeout: 20 minutes }\n" })[0]![1]).toBe('timeout is "20 minutes"; write 20m (durations take s, m or h).');
    expect(found({ yaml: "on:\n  schedule: { at: 9:00, timezone: UTC }\nsteps:\n  a: { prompt: hi }\n" })[0]![1]).toBe('at is "9:00"; write "09:00", with two digits for the hour.');
  });
});

describe("no silent passes (B13, B7)", () => {
  const found = (c: Pick<Case, "yaml" | "files" | "target" | "env">) => run(c).diagnostics.map((d) => [d.code, d.severity, d.message]);

  test("an agent file's model is checked like a step's, and a bad one is dropped so the agent still runs", () => {
    const result = run({ files: [agent("x", "description: X\nmodel: sonet")] });
    expect(result.diagnostics.map((d) => [d.code, d.severity, d.message])).toEqual([
      ["model-invalid", "error", 'model "sonet" is not a model Caveman knows, so this agent runs on the engine\'s default. Did you mean "sonnet"? Use auto, fast, base, frontier, inherit, haiku, sonnet, opus, a model id like claude-sonnet-5-5, or a pin like anthropic/claude-sonnet-5-5.'],
    ]);
    expect(result.agents.find((a) => a.name === "x")?.model).toBeUndefined();
    // Claude-compatible files name bare model ids; a name with a version passes, a bare word does not.
    for (const model of ["auto", "fast", "inherit", "opus", "openrouter/qwen/qwen3-coder", "gpt-5.4-mini", "claude-sonnet-5-5"]) expect(found({ files: [agent("x", `model: ${model}`)] }), model).toEqual([]);
  });

  test("an agent's unknown effort warns, and Claude-style capitals still work", () => {
    expect(found({ files: [agent("x", "effort: ultra")] })).toEqual([
      ["agent-effort-unknown", "warning", 'effort "ultra" is not one Caveman knows, so this agent runs at the engine\'s default effort. Use minimal, low, medium, high, xhigh or max.'],
    ]);
    expect(found({ files: [agent("x", "effort: High")] })).toEqual([]);
  });

  test("a step timeout past the run's 2h deadline says so", () => {
    expect(found({ yaml: "steps:\n  a: { prompt: hi, timeout: 3h }\n" })).toEqual([
      ["timeout-too-long", "error", "timeout is 3h, longer than the 2h a whole run may take in v1, so the run would stop first; use 2h or less."],
    ]);
    expect(found({ yaml: "steps:\n  a: { prompt: hi, timeout: 2h }\n" })).toEqual([]);
  });

  test("label with push warns that pushes never fire", () => {
    expect(found({ yaml: "on:\n  github: { event: [pull_request.opened, push], label: caveman }\nsteps:\n  a: { prompt: hi }\n" })).toEqual([
      ["github-label-never-matches", "warning", "With label set, pushes never fire: they carry no label. Remove label, or give push an automation of its own."],
    ]);
  });

  test("a comment on a scheduled run says it posts only when run by hand on an issue or pull request", () => {
    expect(found({ yaml: "on:\n  schedule: { every: 6h }\nsteps:\n  a: { prompt: hi }\noutputs:\n  github.comment: a.summary\n" })).toEqual([
      ["comment-needs-github", "warning", "A scheduled run has no issue or pull request to comment on; it posts only when you run it by hand on one."],
    ]);
  });

  test("a failure handler in a graph that a skipped step stands in front of says it never runs, and how to wire it", () => {
    const steps = (...lines: ReadonlyArray<string>) => found({ yaml: ["steps:", "  build: { prompt: build it }", "  test: { needs: [build], prompt: test it }", ...lines].join("\n") });
    // build fails, so test is skipped (need_failed), and notify after it (need_skipped).
    expect(steps("  notify: { needs: [test], if: { build: failed }, prompt: tell the team }")).toEqual([
      ["if-failed-never-runs", "warning", '"notify" never runs when "build" fails: "test" is skipped then, and so is every step after it. Have "notify" need "build" instead of "test".'],
    ]);
    // Needing build directly as well does not help while it also waits for test.
    expect(steps("  notify: { needs: [build, test], if: { build: failed }, prompt: tell the team }")).toEqual([
      ["if-failed-never-runs", "warning", '"notify" never runs when "build" fails: "test" is skipped then, and so is every step after it. Remove "test" from the needs of "notify".'],
    ]);
    // A step between them that handles the failure itself still stands behind one that does not.
    expect(steps("  report: { needs: [test], if: { build: failed }, prompt: write it up }", "  notify: { needs: [report], if: { build: failed }, prompt: tell the team }")).toEqual([
      ["if-failed-never-runs", "warning", '"report" never runs when "build" fails: "test" is skipped then, and so is every step after it. Have "report" need "build" instead of "test".'],
      ["if-failed-never-runs", "warning", '"notify" never runs when "build" fails: "test" is skipped then, and so is every step after it. Have "notify" need "build" instead of "report".'],
    ]);
  });

  test("a failure handler that waits on a step which runs only when another step fails, and that failure skips the handler, says it never runs", () => {
    const steps = (...lines: ReadonlyArray<string>) =>
      found({ yaml: ["steps:", "  a: { prompt: a }", "  b: { needs: [a], if: { a: failed }, prompt: b }", "  c: { prompt: c }", ...lines].join("\n") });
    // b runs only when a fails, and d needs a to succeed.
    expect(steps("  d: { needs: [a, b, c], if: { c: failed }, prompt: d }")).toEqual([
      ["if-failed-never-runs", "warning", '"d" never runs when "c" fails: it waits on "b", which runs only when "a" fails, and "d" is skipped when "a" fails.'],
    ]);
    // a's failure skips u (need_failed), which d waits on; b stands one step further off, behind v.
    expect(steps("  u: { needs: [a], prompt: u }", "  v: { needs: [b], prompt: v }", "  d: { needs: [u, v, c], if: { c: failed }, prompt: d }")).toEqual([
      ["if-failed-never-runs", "warning", '"d" never runs when "c" fails: it waits on "v", which runs only when "a" fails, and "d" is skipped when "a" fails.'],
    ]);
  });

  test("a step that tests a decision is skipped when that step fails, and a failure handler behind it never runs", () => {
    const yaml = [
      "steps:",
      "  review: { prompt: r, decides: [ship, hold] }",
      "  lint: { prompt: l }",
      "  stage: { needs: [review], if: { review: failed }, prompt: s }",
      "  release: { needs: [stage, lint], if: { lint: failed, review: ship }, prompt: x }",
      "  notify: { needs: [release], if: { review: failed }, prompt: n }",
    ].join("\n");
    expect(found({ yaml })).toEqual([
      ["if-failed-never-runs", "warning", '"release" never runs when "lint" fails: it waits on "stage", which runs only when "review" fails, and "release" is skipped when "review" fails.'],
      ["if-failed-never-runs", "warning", '"notify" never runs when "review" fails: "release" is skipped then, and so is every step after it. Have "notify" need "review" instead of "release".'],
    ]);
  });

  test("a failure handler that can run says nothing", () => {
    const clean = (yaml: string) => expect(found({ yaml }), yaml).toEqual([]);
    // It needs the failed step alone, or beside a step that does not wait for it.
    clean("steps:\n  build: { prompt: b }\n  lint: { prompt: l }\n  notify: { needs: [build, lint], if: { build: failed }, prompt: n }\n");
    // Every step between them handles the same failure.
    clean("steps:\n  build: { prompt: b }\n  report: { needs: [build], if: { build: failed }, prompt: r }\n  notify: { needs: [report], if: { build: failed }, prompt: n }\n");
    // A step between them that handles another failure runs when both fail, and notify after it.
    clean(
      "steps:\n  build: { prompt: b }\n  lint: { prompt: l }\n  stage: { needs: [build], if: { build: failed }, prompt: s }\n  test: { needs: [stage, lint], if: { lint: failed }, prompt: t }\n  notify: { needs: [test], if: { build: failed }, prompt: n }\n",
    );
    // In file order a skipped step blocks nothing (§1.1), so the same handler runs.
    clean("steps:\n  build: { prompt: b }\n  test: { prompt: t }\n  notify: { if: { build: failed }, prompt: n }\n");
  });
});

describe("decides on prompt steps, and one naming rule (B18)", () => {
  test("a prompt step can decide, and if tests its values; dashes work in decisions and names", () => {
    const yaml = [
      "steps:",
      "  gate:",
      "    prompt: Decide whether this needs a review.",
      "    decides: [review, needs-info]",
      "    model: fast",
      "  fix_it:",
      "    if: { gate: needs-info }",
      "    prompt: Ask for what is missing.",
      "  review:",
      "    if: { gate: review }",
      "    agent: reviewer",
    ].join("\n");
    expect(run({ yaml }).diagnostics).toEqual([]);
    expect(run({ yaml: yaml.replace("{ gate: review }", "{ gate: reveiw }") }).diagnostics.map((d) => d.message)).toEqual([
      'if: { gate: reveiw }: "gate" decides review or needs-info, or failed. Did you mean "review"?',
    ]);
  });

  test("a prompt step without decides says how to add them; reserved and malformed values are caught", () => {
    const messages = (yaml: string) => run({ yaml }).diagnostics.map((d) => d.message);
    expect(messages("steps:\n  gate: { prompt: hi }\n  b:\n    if: { gate: review }\n    prompt: x\n")).toEqual([
      'if: { gate: review }: prompt step "gate" declares no decides, so if can only test gate: failed. Add decides: [review, ...] to "gate", or test failed.',
    ]);
    expect(messages("steps:\n  gate: { prompt: hi, decides: [ok, failed] }\n")).toEqual(["decides lists failed, which the runtime uses for step status; pick another word."]);
    expect(messages("steps:\n  gate: { prompt: hi, decides: [Ship] }\n")).toEqual([
      'decides has "Ship"; use lowercase letters, digits, - and _ (never two _ in a row), starting with a letter, at most 40 characters, like needs_info or needs-info.',
    ]);
    expect(run({ files: [agent("x", "decides: [needs-info, ship_it]")] }).diagnostics).toEqual([]);
    expect(messages("steps:\n  gate: { prompt: hi, decides: review }\n")).toEqual(['decides is "review"; write a list, like decides: [review, skip].']);
    expect(messages("on:\n  schedule: { at: \"09:00\", timezone: UTC, weekdays: mon }\nsteps:\n  a: { prompt: hi }\n")).toEqual(['weekdays is "mon"; write a list, like weekdays: [mon, fri].']);
  });
});

describe("routines: a run step that decides, and the chief output", () => {
  const ROUTINE = [
    "on: { schedule: { every: 5m, timezone: Europe/Amsterdam, until: \"2026-11-22\" } }",
    "steps:",
    "  look:",
    "    run: ./scripts/bugs.sh",
    "    decides: [news, quiet]",
    "  fix:",
    "    if: { look: news }",
    "    prompt: Fix what look found.",
    "outputs:",
    "  chief: { from: look }",
  ].join("\n");

  test("a run step's decides are its command's, and if gates later steps on them", () => {
    expect(run({ yaml: ROUTINE }).diagnostics).toEqual([]);
    expect(run({ yaml: ROUTINE.replace("{ look: news }", "{ look: nwes }") }).diagnostics.map((d) => d.message)).toEqual([
      'if: { look: nwes }: "look" decides news or quiet, or failed. Did you mean "news"?',
    ]);
  });

  test("a run step without decides says how to add them, and a wait step's decides do nothing", () => {
    const messages = (yaml: string) => run({ yaml }).diagnostics.map((d) => [d.code, d.message]);
    expect(messages("steps:\n  look: { run: ./check.sh }\n  b:\n    if: { look: news }\n    prompt: x\n")).toEqual([
      ["if-no-decides", 'if: { look: news }: run step "look" declares no decides, so if can only test look: failed. Add decides: [news, ...] to "look", or test failed.'],
    ]);
    expect(messages("steps:\n  pause: { wait: 1h, decides: [news] }\n")).toEqual([["step-key-unused", "decides does nothing on a wait step, which only waits; remove it."]]);
  });

  test("chief reads a real step, and says when its runs could never wake the Chief", () => {
    const found = (yaml: string) => run({ yaml }).diagnostics.map((d) => [d.code, d.severity, d.message]);
    expect(found(ROUTINE.replace("chief: { from: look }", "chief: { from: lok }"))).toEqual([["output-unknown-step", "error", 'chief reads step "lok", which does not exist. Did you mean "look"?']]);
    expect(found("steps:\n  look: { run: ./check.sh, decides: [found, none] }\noutputs:\n  chief: { from: look }\n")).toEqual([
      ["chief-never-news", "warning", 'chief reads step "look", which never decides news, so its runs only update the routine\'s row and never wake the Chief. Add decides: [news, quiet] to "look", and end its output with decision: news when it found something.'],
    ]);
    expect(found("steps:\n  look: { prompt: Look for bugs., decides: [news, quiet] }\noutputs:\n  chief: { from: look }\n")).toEqual([]);
    expect(found("steps:\n  look: { run: x }\noutputs:\n  chief: look.summary\n").map(([code]) => code)).toEqual(["invalid-value"]);
  });

  test("chief may name the Chief it reports to (to, its id); any other key, or an empty to, is refused", () => {
    const found = (yaml: string) => run({ yaml }).diagnostics.map((d) => [d.code, d.severity]);
    expect(found(ROUTINE.replace("chief: { from: look }", "chief: { from: look, to: 6f1c2a9e-0b7d-4c55-9a8e-3d2f1b0c4e71 }"))).toEqual([]);
    expect(found(ROUTINE.replace("chief: { from: look }", 'chief: { from: look, to: "" }')).map(([code]) => code)).toEqual(["invalid-value"]);
    expect(found(ROUTINE.replace("chief: { from: look }", "chief: { from: look, chief: carl }")).map(([code]) => code)).toEqual(["unknown-key"]);
  });

  test("explain says the Chief gets the report, and the schedule says when it ends", () => {
    const result = run({ yaml: ROUTINE });
    const look = explain({ automation: result.automations[0]!, agents: result.agents, env: ENV }).steps.find((s) => s.name === "look")!;
    expect(look.rows.find((r) => r.key === "outputs")?.value).toBe("chief: look.summary");
    expect(triggerWords(result.automations[0]!.file)[0]).toBe("Every 5m, until 2026-11-22");
  });
});

describe("if in a graph of many steps, judged as the rules read", () => {
  // check works out every if of a graph at once, 32 refs to a pass. This reads SEMANTICS §1.3-1.5 and §2.2 one step at
  // a time instead, over random graphs with more refs than one pass holds, and with a circle now and then.
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const names = (text: string) => [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);

  test("if-not-a-need, if-failed-never-runs and needs-cycle say what a step-by-step reading says", () => {
    const next = random(7);
    const pick = (n: number) => Math.floor(next() * n);
    const seen = { notNeeded: 0, neverRuns: 0, conflicts: 0, cycles: 0, mostRefs: 0 };
    for (let round = 0; round < 120; round++) {
      const count = 20 + pick(70);
      const needs: string[][] = Array.from({ length: count }, (_, i) => (i === 0 ? [] : [...new Set(Array.from({ length: pick(4) }, () => `s${pick(i)}`))]));
      const circle = next() < 0.15;
      if (circle) {
        const a = pick(count - 1);
        const b = a + 1 + pick(count - a - 1);
        needs[a]!.push(`s${b}`);
        if (!needs[b]!.includes(`s${a}`)) needs[b]!.push(`s${a}`);
      }
      const ifs = Array.from({ length: count }, () => new Map<string, string>(next() < 0.6 ? Array.from({ length: 1 + pick(2) }, () => [`s${pick(count)}`, next() < 0.8 ? "failed" : "go"] as const) : []));
      seen.mostRefs = Math.max(seen.mostRefs, new Set(ifs.flatMap((m) => [...m.keys()])).size);
      const yaml = `steps:\n${needs.map((n, i) => `  s${i}: { prompt: p, decides: [go]${n.length > 0 ? `, needs: [${n.join(", ")}]` : ""}${ifs[i]!.size > 0 ? `, if: { ${[...ifs[i]!].map(([r, v]) => `${r}: ${v}`).join(", ")} }` : ""} }`).join("\n")}\n`;

      const below = (name: string, found = new Set<string>()): Set<string> => {
        for (const need of needs[Number(name.slice(1))]!) if (!found.has(need)) below(need, found.add(need));
        return found;
      };
      const testsOf = (step: string) => ifs[Number(step.slice(1))]!;
      // Whether a failure of `failed`, a step `step` needs, skips it: one that tests no failure is skipped by any (§2.2);
      // one that does, by a need it does not test (§1.3) or a step it tests for a decision (§1.5).
      const skippedBy = (step: string, failed: string) => {
        const tests = testsOf(step);
        return below(step).has(failed) && (![...tests.values()].includes("failed") || ((needs[Number(step.slice(1))]!.includes(failed) || tests.has(failed)) && tests.get(failed) !== "failed"));
      };
      // The steps a step needs and tests with failed: it runs only when they fail.
      const runsOnlyWhen = (step: string) => [...testsOf(step)].filter(([ref, value]) => value === "failed" && below(step).has(ref)).map(([ref]) => ref);
      const waitsOnTester = (step: string, failing: string) => [step, ...below(step)].some((s) => runsOnlyWhen(s).includes(failing));
      const notNeeded = new Set<string>();
      const neverRuns = new Map<string, ReadonlyArray<string>>();
      const blockers = new Map<string, ReadonlySet<string>>();
      // By step and ref, when no step between them is skipped: each step whose failure the step can never run beside.
      const conflicts = new Map<string, ReadonlyMap<string, ReadonlyArray<string>>>();
      ifs.forEach((tests, i) => {
        const step = `s${i}`;
        for (const [ref, value] of tests) {
          if (!below(step).has(ref)) notNeeded.add(`${step} ${ref}`);
          else if (value === "failed" && !circle) {
            const skipped = new Set([...below(step)].filter((s) => skippedBy(s, ref)));
            if (skipped.size > 0) {
              blockers.set(`${step} ${ref}`, skipped);
              neverRuns.set(`${step} ${ref}`, needs[i]!.filter((n) => n !== ref && (skipped.has(n) || [...below(n)].some((s) => skipped.has(s)))));
              continue;
            }
            // A step it waits on runs only when x fails, and x's failure skips it or a step it waits on.
            const found = new Map<string, ReadonlyArray<string>>();
            for (const x of new Set([...below(step)].flatMap(runsOnlyWhen))) {
              if (tests.get(x) === "failed" || ![step, ...below(step)].some((s) => skippedBy(s, x))) continue;
              found.set(x, needs[i]!.filter((n) => waitsOnTester(n, x)));
            }
            if (found.size === 0) continue;
            conflicts.set(`${step} ${ref}`, found);
            neverRuns.set(`${step} ${ref}`, []);
          }
        }
      });

      const diagnostics = run({ yaml }).diagnostics;
      expect(new Set(diagnostics.map((d) => d.code)), yaml).toEqual(new Set([...(notNeeded.size > 0 ? ["if-not-a-need"] : []), ...(neverRuns.size > 0 ? ["if-failed-never-runs"] : []), ...(circle ? ["needs-cycle"] : [])]));
      const reported = diagnostics.filter((d) => d.code === "if-not-a-need").map((d) => {
        const [first, second] = names(d.message);
        return d.message.startsWith("if names this step") ? `${first} ${first}` : `${second} ${first}`;
      });
      expect(new Set(reported), yaml).toEqual(notNeeded);
      const never = diagnostics.filter((d) => d.code === "if-failed-never-runs");
      expect(new Set(never.map((d) => names(d.message).slice(0, 2).join(" "))), yaml).toEqual(new Set(neverRuns.keys()));
      for (const d of never) {
        const [step, ref, ...rest] = names(d.message);
        const conflict = conflicts.get(`${step} ${ref}`);
        if (conflict !== undefined) {
          // "it waits on <through>, which run only when <x> fails, and <step> is skipped when <x> fails."
          const failing = rest.at(-3)!;
          expect(rest.slice(-3), d.message).toEqual([failing, step, failing]);
          expect(rest.slice(0, -3), d.message).toEqual(conflict.get(failing));
          continue;
        }
        const [skippedPart, advice] = d.message.split(" skipped then");
        const skipped = names(skippedPart!).slice(2);
        // The steps named as skipped are steps between them that the failure skips, in file order; then the needs to drop.
        expect(skipped.length, d.message).toBeGreaterThan(0);
        expect(skipped.every((s) => blockers.get(`${step} ${ref}`)!.has(s)), d.message).toBe(true);
        expect(skipped, d.message).toEqual([...skipped].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
        expect(names(advice!).filter((n) => n !== step && n !== ref), d.message).toEqual(neverRuns.get(`${step} ${ref}`));
      }
      const cycle = diagnostics.find((d) => d.code === "needs-cycle");
      if (cycle !== undefined) {
        const steps = /\((.*)\)/.exec(cycle.message)![1]!.split(", then ");
        steps.slice(1).forEach((s, i) => expect(needs[Number(steps[i]!.slice(1))], cycle.message).toContain(s));
      }
      seen.notNeeded += notNeeded.size;
      seen.neverRuns += neverRuns.size;
      seen.conflicts += conflicts.size;
      seen.cycles += circle ? 1 : 0;
    }
    // The sweep reaches each kind, and files whose refs take more than one pass.
    expect(seen.notNeeded).toBeGreaterThan(200);
    expect(seen.neverRuns).toBeGreaterThan(200);
    expect(seen.conflicts).toBeGreaterThan(10);
    expect(seen.cycles).toBeGreaterThan(5);
    expect(seen.mostRefs).toBeGreaterThan(32);
  });

  test("a message names at most eight steps or decisions, then says there are more", () => {
    const messages = (yaml: string) => run({ yaml }).diagnostics.map((d) => d.message);
    const twelve = Array.from({ length: 12 }, (_, i) => `  s${i}: { prompt: p${i > 0 ? `, needs: [s${i - 1}]` : ""} }`).join("\n");
    expect(messages(`steps:\n${twelve}\n  b: { prompt: p, needs: [nope] }\n`)).toEqual(['needs names "nope", which is not a step. Steps: s0, s1, s2, s3, s4, s5, s6, s7 and more.']);
    expect(messages(`steps:\n${twelve}\n  b: { prompt: p, needs: [s11], if: { nope: failed } }\n`)).toEqual([
      'if names "nope", which is not a step. Steps "b" needs: s11, s10, s9, s8, s7, s6, s5, s4 and more.',
    ]);
    expect(messages(`steps:\n${twelve.replace(/, needs: \[s\d+\]/g, "")}\n  b: { prompt: p, if: { nope: failed } }\n`)).toEqual([
      'if names "nope", which is not a step. Steps before "b": s0, s1, s2, s3, s4, s5, s6, s7 and more.',
    ]);
    const decides = Array.from({ length: 12 }, (_, i) => `d${i}`).join(", ");
    expect(messages(`steps:\n  a: { prompt: p, decides: [${decides}] }\n  b: { prompt: p, if: { a: zz } }\n`)).toEqual(['if: { a: zz }: "a" decides d0, d1, d2, d3, d4, d5, d6, d7 and more, or failed.']);
    const all = Array.from({ length: 12 }, (_, i) => `s${i}`).join(", ");
    expect(messages(`steps:\n${twelve}\n  b: { prompt: p, needs: [${all}], if: { s0: failed } }\n`)).toEqual([
      '"b" never runs when "s0" fails: "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8" and more are skipped then, and so is every step after them. Remove "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8" and more from the needs of "b".',
    ]);
    // Ten needs that handle another failure, all behind the one step the failure skips.
    const handlers = Array.from({ length: 10 }, (_, i) => `  u${i}: { prompt: p, needs: [test], if: { test: failed } }`).join("\n");
    const behind = Array.from({ length: 10 }, (_, i) => `u${i}`).join(", ");
    expect(messages(`steps:\n  build: { prompt: p }\n  test: { prompt: p, needs: [build] }\n${handlers}\n  notify: { prompt: p, needs: [build, ${behind}], if: { build: failed } }\n`)).toEqual([
      '"notify" never runs when "build" fails: "test" is skipped then, and so is every step after it. Remove "u0", "u1", "u2", "u3", "u4", "u5", "u6", "u7" and more from the needs of "notify".',
    ]);
  });

  test("in a file of many steps, mistyped names stop getting suggestions once ten thousand names were compared", () => {
    const yaml = `steps:\n${Array.from({ length: 200 }, (_, i) => `  s${i}: { prompt: p${i > 0 ? `, needs: [s${i - 1}x]` : ""} }`).join("\n")}\n`;
    const messages = run({ yaml }).diagnostics.map((d) => d.message);
    expect(messages).toHaveLength(199);
    // Each suggestion compares the name with the 199 other steps, so the 51st reaches ten thousand.
    expect(messages.filter((m) => m.includes("Did you mean")).length).toBe(51);
    expect(messages[0]).toBe('needs names "s0x", which is not a step. Did you mean "s0"?');
    expect(messages.at(-1)).toBe('needs names "s198x", which is not a step. Steps: s0, s1, s2, s3, s4, s5, s6, s7 and more.');
  });
});

test("subjectKindOf: what a manual run of the file is about, from its GitHub events", () => {
  const kind = (on: string) => subjectKindOf(parseAutomation({ path: AUTOMATION, text: `${on}steps:\n  a: { prompt: hi }\n` }).file!);
  expect(kind("on:\n  github: { event: [issues.opened, issues.labeled] }\n")).toBe("issue");
  expect(kind("on:\n  github: { event: [pull_request.opened, pull_request.synchronize] }\n")).toBe("pull_request");
  expect(kind("on:\n  github: { event: issue_comment.created }\n")).toBe("issue_or_pull_request");
  expect(kind("on:\n  github: { event: [issues.opened, pull_request.opened] }\n")).toBe("issue_or_pull_request");
  expect(kind("on:\n  github: { event: [push, workflow_run.completed] }\n")).toBeUndefined();
  expect(kind("on:\n  schedule: { every: 6h }\n")).toBeUndefined();
  expect(kind("")).toBeUndefined();
});

test("the package imports nothing from node, so it runs in the browser", () => {
  const sources = ["index", "format", "rules", "diagnostics", "parse", "check", "explain", "templates", "jsonSchema", "templates.generated"];
  for (const name of sources) {
    const text = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
    expect(text, name).not.toMatch(/from "node:|require\(/);
    expect(text, name).not.toMatch(/from "@caveman-app\//);
  }
});
