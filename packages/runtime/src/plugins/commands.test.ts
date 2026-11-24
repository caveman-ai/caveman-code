import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { expandPluginCommand, fillCommand, leadingPluginCommand, type PluginCommand } from "./commands.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-commands-"));
fs.writeFileSync(path.join(dir, "hello.md"), "---\ndescription: Say hello\n---\nSay hello to $1, then: $ARGUMENTS\n");
const commands: ReadonlyArray<PluginCommand> = [
  { name: "kit:hello", description: "Say hello", path: path.join(dir, "hello.md") },
  { name: "kit:gone", description: "", path: path.join(dir, "missing.md") },
];

describe("plugin commands on engines without them", () => {
  it("expands a leading /plugin:command with its arguments, framed as the Caveman SDK frames one", async () => {
    const out = await expandPluginCommand("/kit:hello Ada and Bob", commands);
    expect(out).toBe(
      [
        'Execute explicitly invoked Agent Plugin command "kit:hello". Follow it for this turn.',
        '<agent-plugin-command id="kit:hello">',
        "Say hello to Ada, then: Ada and Bob",
        "</agent-plugin-command>",
        "User arguments:",
        "Ada and Bob",
      ].join("\n\n"),
    );
    expect(await expandPluginCommand("  /kit:hello", commands)).not.toContain("User arguments:");
  });

  it("leaves everything else as typed", async () => {
    for (const text of ["hello /kit:hello", "/compact", "/kit:other", "/kit:gone now", "kit:hello"]) {
      expect(await expandPluginCommand(text, commands)).toBeUndefined();
    }
    expect(leadingPluginCommand("/kit:hello\nline two", commands)).toMatchObject({ args: "line two" });
    expect(fillCommand("a $2 b $9", "x y")).toBe("a y b ");
    // A real command's (anthropics commit-commands) pre-run shell is never run here: the engine runs it, if allowed.
    expect(fillCommand("- Current git status: !`git status`", "")).toBe("- Current git status: (run `git status` first and use its output)");
  });
});
