import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { checkProject, explain, renderExplain, scheduleWords, templates, triggerWords, type EnvSnapshot, type Explanation, type SourceFile } from "../src/index.ts";
import { BUILTINS, ENV } from "./fixtures.ts";

const load = (id: string) => {
  const template = templates.find((t) => t.id === id)!;
  const check = checkProject({ files: template.files, agents: BUILTINS });
  return { automation: check.automations[0]!, agents: check.agents };
};

test("issue-to-pr's implement step, which runs on Cloud", async () => {
  const text = renderExplain(explain({ ...load("issue-to-pr"), step: "implement", env: ENV }));
  await expect(text).toMatchFileSnapshot("./__snapshots__/issue-to-pr.implement.txt");
});

test("every step of pr-review, and morning-digest as a Me automation", async () => {
  await expect(renderExplain(explain({ ...load("pr-review"), env: ENV }))).toMatchFileSnapshot("./__snapshots__/pr-review.txt");
  await expect(renderExplain(explain({ ...load("morning-digest"), env: ENV }))).toMatchFileSnapshot("./__snapshots__/morning-digest.txt");
});

test("rows are structured for the web: header first, then one block per step", () => {
  const e = explain({ ...load("issue-to-pr"), env: ENV });
  expect(e.header.map((r) => r.key)).toEqual(["description", "triggers", "runs on", "budget", "worst case", "levers", "lever", "lever", "lever"]);
  expect(e.steps.map((s) => [s.name, s.source])).toEqual([
    ["triage", "automations/issue-to-pr.yaml:12"],
    ["implement", "automations/issue-to-pr.yaml:15"],
    ["ask", "automations/issue-to-pr.yaml:28"],
  ]);
  const implement = Object.fromEntries(e.steps[1]!.rows.map((r) => [r.key, r]));
  expect(implement.model).toEqual({ key: "model", value: "base · anthropic/claude-sonnet-5-5", source: "class map: Models & keys" });
  // The ladder: frontier on attempt 2, then Codex on attempt 3.
  expect(e.steps[1]!.rows.filter((r) => r.key === "escalate").map((r) => [r.value, r.detail])).toEqual([
    ["frontier · anthropic/claude-opus-5-5", "Attempt 2."],
    ["codex, frontier", "Attempt 3. No frontier model is set for codex here."],
  ]);
  expect(e.header.find((r) => r.key === "runs on")).toMatchObject({ value: "Cloud", source: "line 3" });
  expect(implement.engine).toEqual({ key: "engine", value: "caveman", source: "the new-chat default" });
});

test("a cap below the file's budget, a subscription engine, a missing class and an engine that is signed out", () => {
  const env: EnvSnapshot = { ...ENV, defaultEngine: "claude-agent", budgetCap: { usd: 4, source: "your org" }, classes: { "claude-agent": { base: "claude-sonnet-5-5", source: "built-in table" } } };
  const e = explain({ ...load("issue-to-pr"), env });
  const budget = e.header.find((r) => r.key === "budget")!;
  expect(budget).toEqual({
    key: "budget",
    value: "$4.00 per run, all attempts",
    detail: "The file says $6.00; your org caps it at $4.00. Steps on a subscription login get token and turn caps instead.",
    source: "line 9",
  });
  const triage = Object.fromEntries(e.steps[0]!.rows.map((r) => [r.key, r]));
  expect(triage.model).toEqual({ key: "model", value: "fast", detail: "No fast model is set for claude-agent here.", source: "line 14" });
  expect(triage.engine).toMatchObject({ value: "claude-agent", detail: "On your subscription login." });
  expect(e.header.filter((r) => r.key === "levers" || r.key === "lever")).toEqual([{ key: "levers", value: "Caveman's harness levers: off", source: "they run on the caveman engine only" }]);
  expect(explain({ ...load("issue-to-pr"), env: { ...env, levers: [] } }).header.find((r) => r.key === "levers")).toEqual({ key: "levers", value: "none reported for claude-agent" });

  const codex = explain({ ...load("issue-to-pr"), env: { ...ENV, defaultEngine: "codex" } });
  expect(codex.steps[0]!.rows.find((r) => r.key === "engine")).toMatchObject({ detail: "Not available here: not signed in." });
});

test("triggers in words", () => {
  const words = (id: string) => triggerWords(load(id).automation.file);
  expect(words("pr-review")).toEqual(["Pull request opened or updated touching anything but **/*.md, **/*.mdx, docs/**", "By hand"]);
  expect(words("issue-to-pr")).toEqual(["Issue labelled caveman", "By hand"]);
  expect(words("fix-failing-ci")).toEqual(["CI run failed on the default branch", "By hand"]);
  expect(words("answer-mentions")).toEqual(["Comment mentioning @caveman", "By hand"]);
  expect(words("catch-bugs-merged")).toEqual(["Push to the default branch", "By hand"]);
  expect(words("morning-digest")).toEqual(["Weekdays at 09:00 (Europe/Amsterdam)", "By hand"]);
  expect(words("stale-prs")).toEqual(["Mon at 09:00 (Europe/Amsterdam)", "By hand"]);
});

test("one harness row by default; each lever only with { levers: true }, and the structure keeps them all", () => {
  const e = explain({ ...load("issue-to-pr"), env: ENV });
  const levers = e.header.filter((r) => r.key === "levers" || r.key === "lever");
  expect(levers.map((r) => [r.key, r.value])).toEqual([
    ["levers", "Caveman harness: on"],
    ["lever", "MCP tools called from programs, so raw results stay out of the conversation: on"],
    ["lever", "Long tool output capped at 50 KB or 2,000 lines, the whole of it kept in a file to read: on"],
    ["lever", "The conversation summarized at 80% of the context window: on"],
  ]);
  expect(renderExplain(e).match(/harness|MCP tools called from programs/g)).toEqual(["harness"]);
  expect(renderExplain(e, { levers: true })).toContain("               · MCP tools called from programs, so raw results stay out of the conversation: on");
  // An engine that reports no summary row shows every lever, as before.
  const plain = explain({ ...load("issue-to-pr"), env: { ...ENV, levers: ENV.levers.filter((l) => l.id !== "all") } });
  expect(plain.header.filter((r) => r.key === "levers").length).toBe(3);
});

test("offline, classes say when they resolve and the engine reads the new-chat default once", () => {
  const offline: EnvSnapshot = { host: "this-mac", defaultEngine: "the new-chat default", engines: [], classes: {}, levers: ENV.levers, servedTriggers: ["manual", "schedule", "github"], offline: true };
  const e = explain({ ...load("issue-to-pr"), env: offline });
  const triage = Object.fromEntries(e.steps[0]!.rows.map((r) => [r.key, r]));
  expect(triage.model).toEqual({ key: "model", value: "fast (resolves when Caveman Code runs)", source: "line 14" });
  expect(triage.engine).toEqual({ key: "engine", value: "the new-chat default" });
  expect(e.header.find((r) => r.key === "levers")).toMatchObject({ value: "Caveman harness: on", detail: "When it runs on the caveman engine." });
  expect(renderExplain(e)).not.toMatch(/No fast model is set/);
});

test("the title line names scope and file, an agent check shows its model, and ignored Claude keys are listed", () => {
  const files: SourceFile[] = [
    { path: ".caveman/local/automations/tidy.yaml", text: "steps:\n  tidy:\n    agent: tidier\n    model: fast\n    computer: full\n    checks: [{ agent: strict }, { agent: reviewer }]\n" },
    { path: ".caveman/agents/tidier.md", text: "---\ndescription: Tidies\ncolor: blue\nhooks: {}\n---\nTidy.\n" },
    { path: ".caveman/agents/strict.md", text: "---\ndescription: Strict review\nmodel: frontier\ndecides: [approve, request_changes]\n---\nReview.\n" },
  ];
  const check = checkProject({ files, agents: BUILTINS });
  expect(check.diagnostics).toEqual([]);
  const e = explain({ automation: check.automations[0]!, agents: check.agents, env: ENV });
  const rows = e.steps[0]!.rows;
  expect(rows.find((r) => r.key === "agent")).toEqual({ key: "agent", value: "tidier", source: "agents/tidier.md", detail: "Caveman reads past its Claude Code keys: color, hooks." });
  expect(rows.filter((r) => r.key === "checker")).toEqual([
    { key: "checker", value: "strict: frontier · anthropic/claude-opus-5-5", source: "agents/strict.md" },
    { key: "checker", value: "reviewer: fast · deepseek/deepseek-v4.1-flash", source: "the step's model" },
  ]);
  const text = renderExplain(e);
  const [title, untitled] = text.split("\n");
  expect(title).toMatch(/^tidy · Me {2,}\.caveman\/local\/automations\/tidy\.yaml$/);
  expect(untitled).toBe("  No description: add one line, description: <what it does>, so lists and cards have a title.");
});

test("a prompt step that decides shows what it decides, from its own line", () => {
  const check = checkProject({ files: [{ path: ".caveman/automations/gate.yaml", text: "steps:\n  gate:\n    prompt: Decide.\n    decides: [go, stop]\n" }], agents: BUILTINS });
  const rows = explain({ automation: check.automations[0]!, agents: check.agents, env: ENV }).steps[0]!.rows;
  expect(rows.find((r) => r.key === "decides")).toEqual({ key: "decides", value: "go or stop", source: "line 4" });
});

test("the README's explain sample is this output, so it cannot drift", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const sample = /## explain[\s\S]*?```\n([\s\S]*?)\n```/.exec(readme)?.[1];
  expect(sample).toBe(renderExplain(explain({ ...load("issue-to-pr"), step: "implement", env: ENV })));
});

test("a file with no budget runs on the runtime's default wallet, and explain says so", () => {
  const check = checkProject({ files: [{ path: ".caveman/automations/sweep.yaml", text: "steps:\n  sweep:\n    prompt: List stale branches.\n    model: fast\n" }], agents: BUILTINS });
  const e = explain({ automation: check.automations[0]!, agents: check.agents, env: { ...ENV, defaultBudgetUsd: 10 } });
  expect(e.header.find((r) => r.key === "budget")).toMatchObject({
    value: "$10.00 per run, all attempts",
    detail: expect.stringContaining("The default for a file with no budget; add budget: to set your own."),
    source: "default",
  });
});

describe("a file of many steps", () => {
  const explainText = (text: string) => {
    const check = checkProject({ files: [{ path: ".caveman/automations/long.yaml", text }], agents: BUILTINS });
    return explain({ automation: check.automations[0]!, agents: check.agents, env: ENV });
  };
  const inOrder = (count: number) => explainText(`steps:\n${Array.from({ length: count }, (_, i) => `  s${i}: { prompt: p }`).join("\n")}\n`);
  const sees = (e: Explanation, step: string) => e.steps.find((s) => s.name === step)!.rows.find((r) => r.key === "sees")!.value;

  test("in file order, each step names a few of the steps before it, so the explanation grows with the file, not its square", () => {
    const twelve = inOrder(12);
    expect(sees(twelve, "s1")).toBe("results of s0");
    expect(sees(twelve, "s8")).toBe("results of s0, s1, s2, s3, s4, s5, s6, s7");
    expect(sees(twelve, "s11")).toBe("results of s0, s1, s2, s3, s4, s5, s6, s7 and 3 more");
    // The runtime builds this on its event loop and sends it to the page, as rows and as text.
    const size = (count: number) => {
      const e = inOrder(count);
      return JSON.stringify(e).length + renderExplain(e).length;
    };
    expect(size(4000) / size(2000)).toBeLessThan(2.1);
  });

  test("twenty thousand steps (729 KB, under the 1 MiB the runtime reads) render: more rows than one call takes as arguments", () => {
    const e = explainText(`steps:\n  s0: { prompt: p }\n${Array.from({ length: 19_999 }, (_, i) => `  s${i + 1}: { prompt: p, needs: [s0] }`).join("\n")}\n`);
    expect(e.steps.reduce((n, s) => n + s.rows.length, 0)).toBeGreaterThan(150_000);
    expect(renderExplain(e).split("\n\n").at(-1)).toMatch(/^s19999 +automations\/long\.yaml:20001\n/);
  });
});

test("a schedule says when it runs, its bounds included", () => {
  expect(scheduleWords({ once: "2026-11-09 09:00", timezone: "Europe/Amsterdam" })).toBe("Once on 2026-11-09 at 09:00 (Europe/Amsterdam)");
  expect(scheduleWords({ at: "18:00", timezone: "UTC", monthdays: ["last", 1, 15] })).toBe("Monthly on the 1st, 15th and last day at 18:00 (UTC)");
  expect(scheduleWords({ at: "10:00", timezone: "UTC", weekdays: ["mon"], every: "2w", start: "2026-11-09" })).toBe("Every 2 weeks on Mon at 10:00 (UTC), from 2026-11-09");
  expect(scheduleWords({ at: "10:00", timezone: "UTC", every: "3d", start: "2026-11-09", count: 4 })).toBe("Every 3 days at 10:00 (UTC), from 2026-11-09, 4 runs");
  expect(scheduleWords({ cron: "0 9 * * 1-5", timezone: "UTC", until: "2027-06-30" })).toBe("Cron 0 9 * * 1-5 (UTC), until 2027-06-30");
  expect(scheduleWords({ at: "09:00", timezone: "UTC", weekdays: ["mon", "tue", "wed", "thu", "fri"] })).toBe("Weekdays at 09:00 (UTC)");
  expect(scheduleWords({ every: "6h" })).toBe("Every 6h");
});
