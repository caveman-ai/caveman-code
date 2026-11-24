import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkProject, templates } from "@caveman-app/automations";
import { expect, test } from "vitest";

import { defaultChildModel, delegationRefusal, freshTokens } from "../mcp/delegationPolicy.ts";
import { agentTypePrompt, BUILTIN_AGENT_TYPES, listAgentTypes, parseAgentType } from "./agentTypes.ts";

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test("agent types: Claude-compatible files, project first, then the user's, Space plugins', then the built-ins", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-types-"));
  const project = path.join(root, "repo");
  const home = path.join(root, "home");
  write(path.join(project, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Our reviewer\nmodel: haiku\ntools: Read, Grep\n---\nCheck the style guide.\n");
  write(path.join(project, ".caveman", "agents", "db.md"), "---\ndescription: Migrations\nrole: implementation\n---\nOnly touch db/.\n");
  write(path.join(home, ".caveman", "agents", "db.md"), "---\ndescription: shadowed\n---\n");
  write(path.join(home, ".caveman", "agents", "bad name.md"), "---\nname: bad name\n---\n");
  write(path.join(root, "plugin", "agents", "docs.md"), "---\nname: docs\ndescription: Writes docs\ntools: [Read, Write]\n---\nPlain words.\n");

  const types = await listAgentTypes({ projectRoot: project, home, pluginAgentFiles: [path.join(root, "plugin", "agents", "docs.md")] });
  expect(types.map((t) => [t.name, t.source])).toEqual([
    ["db", "project"],
    ["reviewer", "project"],
    ["docs", "plugin"],
    ["investigator", "builtin"],
    ["builder", "builtin"],
    ["tester", "builtin"],
    ["scout", "builtin"],
  ]);
  expect(types.find((t) => t.name === "tester")).toMatchObject({ role: "test", source: "builtin" });
  expect(types.find((t) => t.name === "reviewer")).toMatchObject({ model: "haiku", tools: ["Read", "Grep"], instructions: "Check the style guide.", role: "general" });
  expect(types.find((t) => t.name === "db")).toMatchObject({ description: "Migrations", role: "implementation" });
  expect(types.find((t) => t.name === "docs")?.tools).toEqual(["Read", "Write"]);
  expect(agentTypePrompt(types.find((t) => t.name === "reviewer")!, "Review #12")).toBe(
    "You are the reviewer agent.\n\nCheck the style guide.\nKeep to these tools: Read, Grep.\n\n---\n\nReview #12",
  );
  expect(parseAgentType("no frontmatter", "x", "user")).toMatchObject({ name: "x", instructions: "no frontmatter" });
  fs.rmSync(root, { recursive: true, force: true });
});

test("agent types read Claude Code's effort, isolation and disallowedTools", () => {
  const type = parseAgentType("---\nname: auditor\neffort: High\nisolation: worktree\ndisallowedTools: Write, Edit\n---\nAudit.\n", "x", "project")!;
  expect(type).toMatchObject({ effort: "high", isolation: "worktree", disallowedTools: ["Write", "Edit"] });
  expect(agentTypePrompt(type, "Audit #3")).toBe("You are the auditor agent.\n\nAudit.\nNever use these tools: Write, Edit.\n\n---\n\nAudit #3");
  // Any other isolation is the default (shared); no effort or list leaves the fields out.
  const plain = parseAgentType("---\nname: plain\nisolation: copy\ndisallowedTools: []\n---\n", "x", "project")!;
  expect(plain.isolation).toBeUndefined();
  expect(plain.disallowedTools).toBeUndefined();
  expect(plain.effort).toBeUndefined();
});

test("agent types read Caveman's engine, decides and returns through the one loader", () => {
  const type = parseAgentType("---\nengine: codex\ndecides: [ship, hold]\nreturns: shipper.schema.json\nhooks: {}\ncolor: red\n---\nShip it.\n", "shipper", "project")!;
  expect(type).toEqual({
    name: "shipper",
    description: "",
    engine: "codex",
    decides: ["ship", "hold"],
    returns: "shipper.schema.json",
    instructions: "Ship it.",
    role: "general",
    source: "project",
  });
  // A wrong engine is check's to report; the agent still loads without it.
  expect(parseAgentType("---\nengine: claude-code\n---\n", "x", "user")).toMatchObject({ name: "x", source: "user" });
  expect(parseAgentType("---\nengine: claude-code\n---\n", "x", "user")!.engine).toBeUndefined();
});

test("the built-ins: the reviewer decides, and the scout drafts automations", () => {
  expect(BUILTIN_AGENT_TYPES.map((t) => t.name)).toEqual(["investigator", "builder", "reviewer", "tester", "scout"]);
  const reviewer = BUILTIN_AGENT_TYPES.find((t) => t.name === "reviewer")!;
  expect(reviewer.decides).toEqual(["approve", "request_changes"]);
  expect(reviewer.instructions).toMatch(/Finish with one line: `decision: approve` .* or `decision: request_changes` when something would\.$/);
  const scout = BUILTIN_AGENT_TYPES.find((t) => t.name === "scout")!;
  expect(scout).toMatchObject({ role: "research", source: "builtin" });
  expect(scout.decides).toBeUndefined();
  expect(scout.instructions).toContain("fenced yaml block");
  // Every template checks clean against the registry's real built-ins.
  for (const template of templates) expect(checkProject({ files: template.files, agents: BUILTIN_AGENT_TYPES }).diagnostics, template.id).toEqual([]);
});

test("delegation policy: limits and the silent token ceiling", () => {
  const limits = { maxDepth: 2, maxConcurrent: 8, treeTokenCeiling: 1000, defaultModel: "auto-by-role" as const };
  expect(delegationRefusal(limits, { callerDepth: 1, running: 7, tokens: 999 })).toBeUndefined();
  expect(delegationRefusal(limits, { callerDepth: 2, running: 0, tokens: 0 })).toContain("at most 2 levels");
  expect(delegationRefusal(limits, { callerDepth: 0, running: 8, tokens: 0 })).toContain("8 delegated agents");
  const budget = delegationRefusal(limits, { callerDepth: 0, running: 0, tokens: 1000 })!;
  expect(budget).toContain("used their budget");
  expect(budget).not.toMatch(/\d/);
  expect(delegationRefusal({ ...limits, treeTokenCeiling: 0 }, { callerDepth: 0, running: 0, tokens: 1e9 })).toBeUndefined();
  expect(
    freshTokens([
      { turnTokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: 1000, cachedInputTokens: 900, outputTokens: 50, hasSubagents: false } },
      {},
    ]),
  ).toBe(150);
});

test("only an agent type's configured model resolves locally; aliases stay in their named family", () => {
  const models = (...slugs: string[]) => ({ models: slugs.map((slug) => ({ slug })) }) as never;
  const claude = models("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5");
  const codex = models("gpt-6.1-sol", "gpt-5.4-mini");
  const resolve = (provider: typeof claude, model?: string, parentModel = "claude-opus-5-5") =>
    defaultChildModel({ provider, parentModel, agentType: model === undefined ? undefined : { model } });
  expect(resolve(claude)).toBeUndefined();
  expect(resolve(claude, "inherit")).toBeUndefined();
  expect(resolve(claude, "haiku")).toBe("claude-haiku-5-5");
  expect(resolve(claude, "sonnet")).toBe("claude-sonnet-5-5");
  expect(resolve(claude, "opus")).toBe("claude-opus-5-5");
  expect(resolve(claude, "claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  expect(resolve(codex, "haiku", "gpt-6.1-sol")).toBeUndefined();
  expect(resolve(codex, "mini", "gpt-6.1-sol")).toBeUndefined();
  expect(resolve(codex, "gpt-5.4-mini", "gpt-6.1-sol")).toBe("gpt-5.4-mini");
  // A provider/model id stays with the parent's provider and stored key.
  expect(resolve(models("openai/gpt-5.4-mini", "anthropic/claude-haiku-5-5"), "haiku", "anthropic/claude-opus-5-5")).toBe("anthropic/claude-haiku-5-5");
  expect(resolve(models("openai/gpt-5.4-mini"), "haiku", "anthropic/claude-opus-5-5")).toBeUndefined();
  expect(resolve(models("haiku-proxy/gpt-5.4-mini"), "haiku", "haiku-proxy/gpt-6.1-sol")).toBeUndefined();
});
