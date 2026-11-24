// The v2 keys together: a graph with needs, parallel attempts with pick, an approval gate, a timer, a command
// step, a rubric and an escalation ladder that names another engine, hosted in Caveman Cloud with its outputs.
import { expect, test } from "vitest";

import { checkProject, explain, isGraph, renderExplain, rungsOf, stepKindOf, triggerWords, writingSteps, type SourceFile } from "../src/index.ts";
import { BUILTINS, ENV } from "./fixtures.ts";

const FILE: SourceFile = {
  path: ".caveman/automations/ship.yaml",
  text: `host: cloud
description: Fix what Slack reports, wait for CI to settle, and ship it once a person approves
on:
  slack: { mention: true, channels: ["#bugs"] }
  linear: { events: [issue.labeled], labels: [caveman], team: ENG }
budget: $8
steps:
  build:
    run: pnpm build
    computer: full
  fix:
    needs: [build]
    agent: builder
    model: fast
    computer: full
    parallel: 3
    pick: best
    checks: [pnpm test]
    retries: 1
    escalate:
      - model: frontier
      - { engine: codex, model: frontier }
    outcome:
      rubric: The failing case from the report passes, and nothing else changed.
      max_iterations: 3
    approve: { by: members, timeout: 48h }
  settle:
    needs: [fix]
    wait: 30m
  notes:
    needs: [build]
    prompt: Write release notes from the change.
    model: fast
outputs:
  slack.message: fix.summary
  linear.comment: { from: notes }
`,
};

const load = () => checkProject({ files: [FILE], agents: BUILTINS, target: "code" });

test("a v2 file with every new key checks clean, even when checked for This Mac, because host: cloud says where it runs", () => {
  const check = load();
  // Only the note that Slack and Linear text is anyone's, so the steps that write wait for the owner (SECURITY M1).
  expect(check.diagnostics.map((d) => [d.code, d.line, d.message])).toEqual([
    ["outsider-approval", 4, 'This run can start from text anyone may write (on.slack, on.linear), so steps "build", "fix" wait for the owner\'s approval each time, before they run.'],
  ]);
  const file = check.automations[0]!.file;
  expect(isGraph(file)).toBe(true);
  expect(Object.fromEntries(Object.entries(file.steps).map(([name, step]) => [name, stepKindOf(step)]))).toEqual({ build: "run", fix: "agent", settle: "wait", notes: "agent" });
  expect(rungsOf(file.steps.fix!.escalate)).toEqual([{ model: "frontier" }, { engine: "codex", model: "frontier" }]);
  expect(rungsOf("frontier")).toEqual([{ model: "frontier" }]);
});

test("the same file on This Mac: every Cloud-only trigger and output is refused at its line", () => {
  const onMac: SourceFile = { ...FILE, text: FILE.text.replace("host: cloud\n", "") };
  const found = checkProject({ files: [onMac], agents: BUILTINS, target: "code" }).diagnostics.map((d) => [d.code, d.line]);
  expect(found).toEqual([
    ["output-needs-cloud", 34],
    ["output-needs-cloud", 35],
    ["trigger-needs-cloud", 3],
    ["trigger-needs-cloud", 4],
  ]);
});

test("explain says where it runs, the order, and what each new key does", () => {
  const check = load();
  const e = explain({ automation: check.automations[0]!, agents: check.agents, env: ENV });
  const header = Object.fromEntries(e.header.map((r) => [r.key, r.value]));
  expect(header["runs on"]).toBe("Cloud");
  expect(e.header.find((r) => r.key === "untrusted")).toMatchObject({
    value: "text anyone may write can start it (on.slack, on.linear)",
    detail: "When a run's text comes from outside the trusted people, steps build, fix wait for the owner's approval before they run. Replies in the thread or issue the text came from, and steps that only read, run as usual.",
    source: "line 4",
  });
  expect(header.order).toBe("a graph: each step starts once its needs are done, up to 4 at once");
  expect(header.triggers).toBe("Slack mention of @caveman in #bugs · Linear issue labelled caveman in ENG · By hand");
  const rows = (name: string) => Object.fromEntries(e.steps.find((s) => s.name === name)!.rows.map((r) => [r.key, r.value]));
  expect(rows("build")).toMatchObject({ runs: "pnpm build" });
  expect(rows("fix")).toMatchObject({
    needs: "build",
    parallel: "3 attempts at once, pick best",
    outcome: "graded against its rubric, up to 3 times",
    approve: "by a member who may write the repository, within 48h",
    outputs: "slack.message: fix.summary",
  });
  expect(rows("settle")).toEqual({ waits: "30m", needs: "fix" });
  expect(rows("notes")).toMatchObject({ sees: "results of build", outputs: "linear.comment: notes.summary" });
  expect(renderExplain(e)).toContain("Cloud posts it when the run ends, if fix succeeded; agents hold no token for it.");
  expect(triggerWords(check.automations[0]!.file)).toContain("Slack mention of @caveman in #bugs");
});

test("untrusted text (SECURITY M1): a reply where the text came from runs as usual; a post elsewhere, a pull request and a full computer wait", () => {
  const file = (on: string, steps: string, outputs: string) =>
    checkProject({ files: [{ path: ".caveman/automations/x.yaml", text: `host: cloud\non:\n${on}\nsteps:\n${steps}\noutputs:\n${outputs}\n` }], agents: BUILTINS, target: "cloud" }).automations[0]!.file;
  const answer = "  answer: { prompt: answer it, computer: none }";
  // The Slack thread, the Linear and Jira issue, the GitHub issue or pull request that started the run.
  expect(writingSteps(file("  slack: { mention: true }", answer, "  slack.message: answer.summary"))).toEqual([]);
  expect(writingSteps(file("  slack: { mention: true }", answer, "  slack.message: { from: answer }"))).toEqual([]);
  expect(writingSteps(file("  linear: { events: [comment.mention] }", answer, "  linear.comment: answer.summary"))).toEqual([]);
  expect(writingSteps(file("  jira: { events: [issue.created] }", answer, "  jira.comment: answer.summary"))).toEqual([]);
  expect(writingSteps(file("  github: { event: issues.opened, actors: any }", answer, "  github.comment: answer.summary"))).toEqual([]);
  // Anywhere else, a pull request, or the run's branch.
  expect(writingSteps(file("  slack: { mention: true }", answer, '  slack.message: { from: answer, channel: "#ops" }'))).toEqual(["answer"]);
  expect(writingSteps(file("  github: { event: issues.opened, actors: any }", "  fix: { prompt: fix it, computer: full }", "  github.pull_request: { from: fix }"))).toEqual(["fix"]);
  expect(writingSteps(file("  slack: { mention: true }", `${answer}\n  fix: { prompt: fix it, computer: full }`, "  slack.message: answer.summary"))).toEqual(["fix"]);
});
