// ), apps/server/src/provider/Drivers/ClaudeSkillDispatch.test.ts @ ab3a3cd1.
import { describe, expect, it } from "vitest";

import { inlineClaudeSkillMentions, planClaudeSkillDispatch } from "./ClaudeSkillDispatch.ts";

const SKILLS = new Set(["2spec", "implement", "review", "re-release-version"]);

describe("planClaudeSkillDispatch", () => {
  it("leaves a prompt without a known skill untouched", () => {
    expect(planClaudeSkillDispatch("fix the build", SKILLS)).toBeUndefined();
    // Not a discovered skill, so it stays prose rather than becoming a command.
    expect(planClaudeSkillDispatch("echo $HOME then $unknown", SKILLS)).toBeUndefined();
  });

  it("keeps the whole request ahead of a mid-prompt slash command", () => {
    expect(planClaudeSkillDispatch("ok, now $implement all the tickets", SKILLS)).toEqual({
      leadingText: "ok, now /implement all the tickets",
      commandText: "/implement all the tickets",
      skillName: "implement",
    });
  });

  it("keeps a mention that opens the prompt as a single command block", () => {
    expect(planClaudeSkillDispatch("$review\nfocus on auth", SKILLS)).toEqual({
      leadingText: undefined,
      commandText: "/review\nfocus on auth",
      skillName: "review",
    });
  });

  it("dispatches a known skill whose name begins with a digit", () => {
    expect(planClaudeSkillDispatch("use $2spec for this", SKILLS)).toEqual({
      leadingText: "use /2spec for this",
      commandText: "/2spec for this",
      skillName: "2spec",
    });
  });

  it("dispatches the last mention and rewrites earlier ones inline", () => {
    expect(planClaudeSkillDispatch("$review the diff, then $implement the fixes", SKILLS)).toEqual({
      leadingText: "/review the diff, then /implement the fixes",
      commandText: "/implement the fixes",
      skillName: "implement",
    });
  });

  it("dispatches currency-prefixed mentions and preserves their source boundaries", () => {
    for (const symbol of ["€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(
        planClaudeSkillDispatch(
          `${symbol}review the diff, then ${symbol}implement the fixes`,
          SKILLS,
        ),
      ).toEqual({
        leadingText: "/review the diff, then /implement the fixes",
        commandText: "/implement the fixes",
        skillName: "implement",
      });
      expect(planClaudeSkillDispatch(`${symbol}2spec for this`, SKILLS)).toEqual({
        leadingText: undefined,
        commandText: "/2spec for this",
        skillName: "2spec",
      });
      expect(planClaudeSkillDispatch(`5${symbol}review ${symbol}unknown`, SKILLS)).toBeUndefined();
    }
  });

  it("ignores a dollar token glued to other text", () => {
    expect(planClaudeSkillDispatch("cost is 5$implement", SKILLS)).toBeUndefined();
  });

  it("ignores currency amounts and compact monetary expressions", () => {
    const skillsWithCurrency = new Set([...SKILLS, "20", "20k", "100M", "1e6"]);
    for (const symbol of ["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(
        planClaudeSkillDispatch(
          `pay ${symbol}20 ${symbol}20k ${symbol}100M ${symbol}1e6 tomorrow`,
          skillsWithCurrency,
        ),
      ).toBeUndefined();
    }
  });
});

describe("inlineClaudeSkillMentions", () => {
  it("writes every known mention as an inline /name and leaves the rest", () => {
    expect(inlineClaudeSkillMentions("$implement then $review but not $HOME or €20", SKILLS)).toBe("/implement then /review but not $HOME or €20");
  });
});

describe("a mention that names a plugin's skill", () => {
  // Claude publishes a plugin's skill as /plugin:folder; the composer sends its folder or frontmatter name.
  const NAMES = new Map([
    ["review", "review"],
    ["lane-echo", "lane-kit:lane-echo"],
    ["lane-kit:lane-echo", "lane-kit:lane-echo"],
    ["release", "my-skills:release"],
  ]);

  it("dispatches the command Claude runs, not the name typed", () => {
    expect(planClaudeSkillDispatch("please $lane-echo now", NAMES)).toEqual({
      leadingText: "please /lane-kit:lane-echo now",
      commandText: "/lane-kit:lane-echo now",
      skillName: "lane-kit:lane-echo",
    });
    expect(planClaudeSkillDispatch("$lane-kit:lane-echo", NAMES)?.commandText).toBe("/lane-kit:lane-echo");
    expect(planClaudeSkillDispatch("$release then $review", NAMES)?.leadingText).toBe("/my-skills:release then /review");
  });

  it("writes inline mentions under their commands too", () => {
    expect(inlineClaudeSkillMentions("$release and $lane-echo but not $HOME", NAMES)).toBe("/my-skills:release and /lane-kit:lane-echo but not $HOME");
  });
});

describe("planClaudeSkillDispatch with user-only skills", () => {
  const skillPath = (name: string) => `/home/me/.claude/skills/${name}/SKILL.md`;

  it("bounds notes for repeated user-only skills and leaves the native dispatch unannotated", () => {
    const skills = new Map([
      ["interrogate", { command: "interrogate", path: skillPath("interrogate"), userInvocationOnly: true }],
      ["implement", { command: "implement", path: skillPath("implement"), userInvocationOnly: true }],
    ]);
    expect(
      planClaudeSkillDispatch("$interrogate then $interrogate then $implement and $implement the fixes", skills),
    ).toEqual({
      leadingText: `/interrogate [The user invoked this skill. Follow the instructions at: ${skillPath("interrogate")}] then /interrogate then /implement and /implement the fixes`,
      commandText: "/implement the fixes",
      skillName: "implement",
    });
  });

  it("leaves a skill the model may start, and a plugin's, unannotated", () => {
    const skills = new Map<string, string | { command: string; path: string }>([
      ["review", { command: "review", path: skillPath("review") }],
      ["lane-echo", "lane-kit:lane-echo"],
    ]);
    expect(planClaudeSkillDispatch("$review and $lane-echo then $review now", skills)?.leadingText).toBe(
      "/review and /lane-kit:lane-echo then /review now",
    );
  });
});
