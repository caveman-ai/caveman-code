import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as plugins from "@caveman-ai/agent/plugins";
import { describe, expect, it } from "vitest";

import { expandSkillMentions } from "./skillMentions.ts";

const environment = async () => {
  const root = mkdtempSync(join(tmpdir(), "caveman-skill-mentions-"));
  const skills: ReadonlyArray<readonly [string, string]> = [
    ["lane-echo", "Reply with LANE-SKILL-OK-7731."],
    ["review", "Read the diff twice."],
  ];
  for (const [name, body] of skills) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
  }
  return plugins.loadAgentEnvironment({ cwd: root, skillRoots: [root], includeDefaultRoots: false, includeWorkspacePlugin: false });
};

describe("expandSkillMentions", () => {
  it("puts a mentioned skill's body in the turn, then the person's words", async () => {
    const env = await environment();
    const out = expandSkillMentions(plugins, "please $lane-echo now", env);
    expect(out).toContain('Apply explicitly invoked Agent Skill "lane-echo"');
    expect(out).toContain("Reply with LANE-SKILL-OK-7731.");
    expect(out.endsWith("User request:\n\nplease $lane-echo now")).toBe(true);
  });

  it("a message that is only the mention is the skill alone; each skill once", async () => {
    const env = await environment();
    const out = expandSkillMentions(plugins, "$lane-echo", env);
    expect(out).toContain("LANE-SKILL-OK-7731");
    expect(out).not.toContain("User request:");
    const both = expandSkillMentions(plugins, "$review then $lane-echo and $review again", env);
    expect(both.match(/Apply explicitly invoked/g)).toHaveLength(2);
    expect(both.indexOf('"review"')).toBeLessThan(both.indexOf('"lane-echo"'));
  });

  it("leaves text without a loaded skill's mention alone", async () => {
    const env = await environment();
    for (const text of ["echo $HOME and $unknown", "cost 5$review", "$review, then", "no mentions"]) {
      expect(expandSkillMentions(plugins, text, env)).toBe(text);
    }
    expect(expandSkillMentions(plugins, "$review", undefined)).toBe("$review");
  });
});
