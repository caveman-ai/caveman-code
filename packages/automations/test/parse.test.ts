import { describe, expect, test } from "vitest";

import { budgetOf, checkProject, durationMs, parseAgentFile, parseAutomation, renderDiagnostics, sha256Hex, type Diagnostic } from "../src/index.ts";

const parse = (text: string) => parseAutomation({ path: ".caveman/automations/a.yaml", text });

describe("automation files", () => {
  test("the smallest automation is five lines, and YAML 1.2 keeps on and 09:00 as strings", () => {
    const { file, diagnostics } = parse(
      'on: { schedule: { at: 09:00, timezone: Europe/Amsterdam, weekdays: [mon, tue, wed, thu, fri] } }\nsteps:\n  digest:\n    prompt: Summarise yesterday\'s merged PRs.\n    model: fast\n',
    );
    expect(diagnostics).toEqual([]);
    expect(file).toEqual({
      on: { schedule: { at: "09:00", timezone: "Europe/Amsterdam", weekdays: ["mon", "tue", "wed", "thu", "fri"] } },
      steps: { digest: { prompt: "Summarise yesterday's merged PRs.", model: "fast" } },
    });
  });

  test("budgets in every written form", () => {
    for (const [written, usd] of [["$6", 6], ["6", 6], ['"$1.50"', 1.5], ["{ usd: 2.5 }", 2.5]] as const) {
      const { file, diagnostics } = parse(`budget: ${written}\nsteps:\n  a: { prompt: hi }\n`);
      expect(diagnostics, written).toEqual([]);
      expect(budgetOf(file!.budget)).toEqual({ usd });
    }
    expect(budgetOf({ usd: 6, tokens: 2_000_000, turns: 200 })).toEqual({ usd: 6, tokens: 2_000_000, turns: 200 });
  });

  test("durations, models and steps in file order", () => {
    expect([durationMs("90s"), durationMs("30m"), durationMs("2h"), durationMs("2 hours")]).toEqual([90_000, 1_800_000, 7_200_000, undefined]);
    const { file, diagnostics } = parse(
      "steps:\n  z: { prompt: a, model: auto }\n  a: { prompt: b, model: anthropic/claude-opus-5-5 }\n  m: { prompt: c, model: openrouter/qwen/qwen3-coder }\n",
    );
    expect(diagnostics).toEqual([]);
    expect(Object.keys(file!.steps)).toEqual(["z", "a", "m"]);
  });

  test("every problem in one pass, each at its line and column", () => {
    const { file, diagnostics } = parse(
      ["on:", "  github: { event: issues.labled }", "steps:", "  implement:", "    agent: builder", "    computer: ful", "    retries: 5", "    timout: 30m"].join("\n"),
    );
    expect(file).toBeUndefined();
    expect(renderDiagnostics(diagnostics)).toBe(
      [
        '.caveman/automations/a.yaml:2:20  "issues.labled" is not a GitHub event Caveman watches. Did you mean "issues.labeled"? Watched events: issues.opened, issues.labeled, pull_request.opened, pull_request.synchronize, issue_comment.created, push, workflow_run.completed, pull_request.labeled, pull_request.closed, check_suite.completed.',
        '.caveman/automations/a.yaml:6:15  computer is "ful"; use none, code, readonly or full. Did you mean "full"?',
        ".caveman/automations/a.yaml:7:14  retries is 5; use a whole number from 0 to 3.",
        '.caveman/automations/a.yaml:8:5   Unknown key "timout" in step "implement". Did you mean "timeout"?',
        "",
        "4 errors",
      ].join("\n"),
    );
  });

  test("a top level that is not a map, and YAML that does not parse", () => {
    expect(parse("- a\n- b\n").diagnostics.map((d) => d.code)).toEqual(["invalid-value"]);
    expect(parse("steps:\n  a: 1\n  a: 2\n").diagnostics.map((d) => [d.code, d.line])).toEqual([["yaml-syntax", 3]]);
  });

  test("a byte-order mark at the start is fine; one later is not", () => {
    expect(parse("﻿steps:\n  a: { prompt: hi }\n").diagnostics).toEqual([]);
    expect(parse("steps:\n  a: { prompt: ﻿hi }\n").diagnostics.map((d) => d.code)).toEqual(["hidden-character"]);
  });
});

describe("agent files", () => {
  const agent = (text: string, path = ".claude/agents/reviewer.md") => parseAgentFile({ path, text }, "project");

  test("Claude Code's files load unchanged: tools as a string or a list, aliases, inherit", () => {
    expect(agent("---\nname: reviewer\ndescription: Our reviewer\nmodel: haiku\ntools: Read, Grep\n---\nCheck the style guide.\n").agent).toEqual({
      name: "reviewer",
      description: "Our reviewer",
      model: "haiku",
      tools: ["Read", "Grep"],
      source: "project",
      path: ".claude/agents/reviewer.md",
      instructions: "Check the style guide.",
      ignoredKeys: [],
    });
    expect(agent("---\ntools: [Read, Write]\nmodel: inherit\n---\n").agent).toMatchObject({ name: "reviewer", tools: ["Read", "Write"], model: "inherit" });
    expect(agent("no frontmatter", "x.md").agent).toMatchObject({ name: "x", instructions: "no frontmatter" });
  });

  test("Caveman's keys: engine, decides, returns, effort, isolation, role", () => {
    const { agent: parsed, diagnostics } = agent(
      "---\nname: auditor\nengine: acp:gemini\ndecides: approve, request_changes\nreturns: auditor.schema.json\neffort: High\nisolation: worktree\nrole: review\n---\nAudit.\n",
    );
    expect(diagnostics).toEqual([]);
    expect(parsed).toMatchObject({ engine: "acp:gemini", decides: ["approve", "request_changes"], returns: "auditor.schema.json", effort: "high", isolation: "worktree", role: "review" });
  });

  test("Claude-only keys are read past and listed; reserved keys warn; a broken frontmatter still loads", () => {
    const { agent: parsed, diagnostics } = agent("---\nname: x\nhooks: {}\nmcpServers: {}\npermissionMode: plan\ncolor: blue\nskills: [a]\n---\nBody\n");
    expect(parsed?.ignoredKeys).toEqual(["hooks", "mcpServers", "permissionMode", "color"]);
    expect(diagnostics.map((d) => [d.code, d.severity, d.line])).toEqual([["agent-key-not-applied", "warning", 7]]);
    const broken = agent("---\nname: [x\n---\nStill here.\n", ".caveman/agents/fallback.md");
    expect(broken.agent).toMatchObject({ name: "fallback", instructions: "Still here." });
    expect(broken.diagnostics.map((d) => d.code)).toEqual(["yaml-syntax"]);
  });

  test("a frontmatter mistake that points at another line counts that line from the top of the file", () => {
    const syntax = (text: string) => agent(text).diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`);
    expect(syntax("---\nname: h\nname: g\n---\nBody\n")).toEqual(['3:1 "name" is already set on line 2; keep one of them.']);
    expect(syntax("---\nname: h\ntools:\n  - Read\n - Grep\n---\nBody\n")).toEqual(["5:2 This - is not lined up with the - on line 4; give them the same indent."]);
  });

  test("a bad engine or decides value is reported and dropped, and the agent still loads", () => {
    const { agent: parsed, diagnostics } = agent("---\nengine: claude-code\ndecides: [ship, failed]\n---\n");
    expect(parsed).toMatchObject({ name: "reviewer", decides: ["ship"] });
    expect(parsed?.engine).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toEqual(["engine-unknown", "decides-reserved"]);
  });

  test("computer is an agent key: none, code, readonly or full; a bad value warns with the closest and is dropped", () => {
    expect(agent("---\nname: billing\ncomputer: none\n---\nAnswer billing questions.\n")).toMatchObject({ agent: { name: "billing", computer: "none" }, diagnostics: [] });
    expect(agent("---\nname: analyst\ncomputer: code\n---\nCompose tool calls.\n")).toMatchObject({ agent: { name: "analyst", computer: "code" }, diagnostics: [] });
    expect(agent("---\ncomputer: full\n---\n").agent?.computer).toBe("full");
    // A warning, not an error: an agent version that loaded before (Cloud's headless start) still loads.
    const bad = agent("---\ncomputer: nonee\n---\n");
    expect(bad.agent?.computer).toBeUndefined();
    expect(bad.diagnostics.map((d) => [d.code, d.severity, d.line])).toEqual([["agent-computer-invalid", "warning", 2]]);
    expect(bad.diagnostics[0]?.message).toContain('Did you mean "none"?');
    expect(agent("---\nname: x\n---\n").agent?.computer).toBeUndefined();
  });

  test("inline mcpServers are surfaced for hosts that start them, and still listed as read past by chats", () => {
    const { agent: parsed, diagnostics } = agent(
      '---\n{"name": "engineer", "mcpServers": {"cave": {"command": "node", "args": ["/opt/caveman/mcp/mcp.mjs"], "env": {"CAVE_TOKEN": "${CAVE_TOKEN}"}}, "docs": {"type": "http", "url": "https://mcp.example.com/mcp"}, "bad name!": {"command": "x"}, "broken": {"type": "http"}}}\n---\nWork.\n',
    );
    expect(parsed?.mcpServers).toEqual({
      cave: { type: "stdio", command: "node", args: ["/opt/caveman/mcp/mcp.mjs"], env: { CAVE_TOKEN: "${CAVE_TOKEN}" } },
      docs: { type: "http", url: "https://mcp.example.com/mcp" },
    });
    expect(parsed?.ignoredKeys).toEqual(["mcpServers"]);
    expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ["mcp-server-invalid", "warning"],
      ["mcp-server-invalid", "warning"],
    ]);
    // Claude's list form names servers configured elsewhere: nothing to start here.
    expect(agent("---\nmcpServers: [github]\n---\n").agent?.mcpServers).toBeUndefined();
  });
});

describe("YAML aliases: a problem with one is reported at its line, never thrown", () => {
  const aliases = (n: number, name: string) => Array(n).fill(`*${name}`).join(", ");
  // 10 x 11 x 11 copies, past the 100 the parser expands.
  const BOMB = `x: &a [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]\ny: &b [${aliases(11, "a")}]\nz: [${aliases(11, "b")}]`;
  const BOMB_AGENT = `---\nname: helper\ndescription: Helps.\n${BOMB}\n---\nHelp.\n`;
  const found = (diagnostics: ReadonlyArray<Diagnostic>) => diagnostics.map((d) => [d.code, d.line, d.column, d.message]);

  test("in an automation: an alias with no anchor, one inside the value it repeats, and aliases past the cap", () => {
    expect(found(parse("steps:\n  a: { prompt: hi, needs: [*nope] }\n").diagnostics)).toEqual([
      ["yaml-syntax", 2, 28, "*nope names no anchor above it; mark the value to repeat with &nope before this line, or write the value out."],
    ]);
    expect(found(parse("steps:\n  a: &a { prompt: hi, needs: [*a] }\n").diagnostics)).toEqual([
      ["yaml-syntax", 2, 31, "*a sits inside the value marked &a, so it would repeat itself forever; write the value out instead."],
    ]);
    expect(found(parse(`steps:\n  a: { prompt: hi }\n${BOMB}\n`).diagnostics)).toEqual([
      ["yaml-syntax", 4, 8, "These aliases expand to more than 100 copies of a value, more than Caveman reads; write the values out instead."],
    ]);
    // Within bounds an alias repeats its value.
    expect(parse("steps:\n  a: { prompt: &p hi }\n  b: { prompt: *p }\n")).toEqual({ file: { steps: { a: { prompt: "hi" }, b: { prompt: "hi" } } }, diagnostics: [] });
  });

  test("in an agent's frontmatter: reported, and the agent still loads", () => {
    const { agent, diagnostics } = parseAgentFile({ path: ".claude/agents/helper.md", text: BOMB_AGENT }, "project");
    expect(found(diagnostics)).toEqual([
      ["yaml-syntax", 5, 8, "These aliases expand to more than 100 copies of a value, more than Caveman reads; write the values out instead."],
    ]);
    expect(agent).toMatchObject({ name: "helper", instructions: "Help." });
    expect(found(parseAgentFile({ path: ".claude/agents/helper.md", text: "---\ntools: &t [Read, *t]\n---\n" }, "project").diagnostics)).toEqual([
      ["yaml-syntax", 2, 18, "*t sits inside the value marked &t, so it would repeat itself forever; write the value out instead."],
    ]);
  });

  test("aliases count as their values written out against the 1 MiB check reads", () => {
    // 300,000 characters, then three copies: 1.2 MB as read.
    const big = `"${"x".repeat(300_000)}"`;
    expect(found(parse(`steps:\n  a: { prompt: &p ${big} }\n  b: { prompt: *p }\n  c: { prompt: *p }\n  d: { prompt: *p }\n`).diagnostics)).toEqual([
      ["yaml-syntax", 5, 16, "*p takes this file past the 1 MiB check reads, counting each alias as its value written out; repeat less, or split the file."],
    ]);
    // An alias inside a repeated value is written out with it.
    expect(found(parse(`x: &p ${big}\ny: &q [*p, *p]\nz: *q\nsteps:\n  a: { prompt: hi }\n`).diagnostics)).toEqual([
      ["yaml-syntax", 3, 4, "*q takes this file past the 1 MiB check reads, counting each alias as its value written out; repeat less, or split the file."],
    ]);
    // 20,000 needs that 99 steps repeat: 620 KB as written, and every rule of check read them 100 times over. The third
    // copy, on w2, is one too many.
    const steps = Array.from({ length: 20_000 }, (_, i) => `s${i}`);
    const text = `steps:\n${steps.map((s) => `  ${s}: { prompt: p }\n`).join("")}  all: { prompt: p, needs: &all [${steps.join(", ")}] }\n${Array.from({ length: 99 }, (_, i) => `  w${i}: { prompt: p, needs: *all }\n`).join("")}`;
    expect(text.length).toBeLessThan(1024 * 1024);
    const result = checkProject({ files: [{ path: ".caveman/automations/many.yaml", text }], agents: [] });
    expect(result.automations).toEqual([]);
    expect(result.diagnostics.map((d) => [d.code, d.line, d.message.slice(0, 50)])).toEqual([["yaml-syntax", 20_005, "*all takes this file past the 1 MiB check reads, c"]]);
    // Within the cap, an alias still repeats its value.
    expect(parse(`steps:\n  a: { prompt: &p ${big} }\n  b: { prompt: *p }\n`).diagnostics).toEqual([]);
    // In an agent's frontmatter: reported, and the agent still loads.
    const { agent, diagnostics } = parseAgentFile({ path: ".claude/agents/helper.md", text: `---\nx: &p ${big}\ny: *p\nz: *p\nw: *p\n---\nHelp.\n` }, "project");
    expect(found(diagnostics)).toEqual([
      ["yaml-syntax", 5, 4, "*p takes this file past the 1 MiB check reads, counting each alias as its value written out; repeat less, or split the file."],
    ]);
    expect(agent).toMatchObject({ name: "helper", instructions: "Help." });
  });

  test("one file's alias problem does not stop the check of the others", () => {
    const result = checkProject({
      files: [
        { path: ".caveman/agents/helper.md", text: BOMB_AGENT },
        { path: ".caveman/automations/bad.yaml", text: "steps:\n  a: { prompt: *nope }\n" },
        { path: ".caveman/automations/good.yaml", text: "steps:\n  a: { prompt: hi }\n" },
      ],
      agents: [],
    });
    expect(result.automations.map((a) => a.name)).toEqual(["good"]);
    expect(result.diagnostics.map((d) => [d.path, d.code])).toEqual([
      [".caveman/agents/helper.md", "yaml-syntax"],
      [".caveman/automations/bad.yaml", "yaml-syntax"],
    ]);
  });
});

test("sha256 matches the standard vectors", () => {
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256Hex("é".repeat(100))).toBe("f42ec48e1e4b487e590e0b3d4e58437c8327efa855d769709f4942a4f73a7eb6");
  expect(sha256Hex("a".repeat(56))).toBe("b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a");
});
