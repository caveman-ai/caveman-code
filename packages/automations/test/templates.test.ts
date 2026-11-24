import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { buildTemplatesModule, generatedPath } from "../scripts/build-templates.ts";
import { NAME_PATTERN, TEMPLATE_CATEGORIES, checkProject, templateSummary, templates } from "../src/index.ts";
import { BUILTINS } from "./fixtures.ts";

test("the generated module matches templates/ (run `pnpm build:templates` to update)", () => {
  expect(readFileSync(generatedPath, "utf8")).toBe(buildTemplatesModule());
});

test("the v1 templates, each checking clean in Caveman Code", () => {
  expect(templates.map((t) => t.id).sort()).toEqual(
    ["answer-mentions", "catch-bugs-merged", "dependency-update", "fix-failing-ci", "issue-to-pr", "month-end-review", "morning-digest", "nightly-digest", "pr-review", "security-review", "slack-triage", "stale-prs", "weekly-changelog"],
  );
  for (const template of templates) {
    expect(NAME_PATTERN.test(template.id), template.id).toBe(true);
    expect(TEMPLATE_CATEGORIES).toContain(template.category);
    const check = checkProject({ files: template.files, agents: BUILTINS, target: "code" });
    expect(check.diagnostics, template.id).toEqual([]);
    expect(check.automations.map((a) => [a.name, a.scope]), template.id).toEqual([[template.id, template.scope]]);
    // No templating: the files are written as they are.
    for (const file of template.files) expect(file.text, file.path).not.toContain("{{");
  }
});

test("templates that share an agent file share its exact text, so creating two never conflicts", () => {
  const seen = new Map<string, string>();
  for (const file of templates.flatMap((t) => t.files)) {
    const before = seen.get(file.path);
    if (before !== undefined) expect(file.text, file.path).toBe(before);
    seen.set(file.path, file.text);
  }
});

test("chips come from the triggers, and the summary lists what Create writes", () => {
  const byId = Object.fromEntries(templates.map((t) => [t.id, t]));
  expect(byId["pr-review"]!.chips).toEqual(["GitHub"]);
  expect(byId["morning-digest"]!.chips).toEqual(["Schedule"]);
  expect(templateSummary(byId["issue-to-pr"]!)).toEqual({
    id: "issue-to-pr",
    title: "Issue to PR",
    category: "Issues and PRs",
    summary: "Label an issue caveman to get a reviewed draft PR or a question back. Runs on Cloud.",
    chips: ["GitHub"],
    scope: "project",
    host: "cloud",
    paths: [".caveman/automations/issue-to-pr.yaml", ".caveman/agents/clarifier.md", ".caveman/agents/issue-triage.md"],
    steps: [
      { name: "triage", agent: "issue-triage", model: "fast", computer: "readonly" },
      { name: "implement", agent: "builder", model: "base", computer: "full" },
      { name: "ask", agent: "clarifier", model: "fast", computer: "readonly" },
    ],
    budget: 6,
  });
  expect(templateSummary(byId["morning-digest"]!).paths).toEqual([".caveman/local/automations/morning-digest.yaml"]);
  expect(byId["morning-digest"]!.host).toBe("this-mac");
  expect([byId["slack-triage"]!.chips, byId["slack-triage"]!.host]).toEqual([["Slack"], "cloud"]);
  expect([byId["nightly-digest"]!.chips, byId["nightly-digest"]!.host]).toEqual([["Schedule", "Slack"], "cloud"]);
});

test("no template shadows a built-in agent, and every summary fits two short lines", () => {
  const builtins = new Set(BUILTINS.map((a) => a.name));
  for (const template of templates) {
    for (const file of template.files.slice(1)) expect(builtins.has(file.path.slice(".caveman/agents/".length, -3)), file.path).toBe(false);
    expect(template.summary.length, template.id).toBeLessThanOrEqual(110);
  }
});

test("templates promise only what they run: commented checks are a note to add yours, and reports cover what they say", () => {
  const text = (id: string) => templates.find((t) => t.id === id)!.files.map((f) => f.text).join("\n");
  for (const id of ["issue-to-pr", "dependency-update", "fix-failing-ci"]) {
    expect(text(id), id).toMatch(/# Add (your|the) .*here, so/);
    expect(templates.find((t) => t.id === id)!.summary, id).not.toMatch(/checks pass/);
  }
  expect(text("weekly-changelog")).toContain('gh pr list --state merged --search "merged:>=');
  expect(text("weekly-changelog")).not.toContain("git log --merges --since");
  expect(text("morning-digest")).toMatch(/last working day[\s\S]*Friday/);
});
