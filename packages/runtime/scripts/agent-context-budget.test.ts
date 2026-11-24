// Keeps agentContextBudget.json equal to the context the runtime hands every agent on every turn
// (agent-context-size.ts measures it). CI's agent-context-budget job fails a pull request that raises
// a value above its base branch's, so the context can't grow by editing the file; growth on purpose
// takes the agent-context-increase label. ).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import budget from "../agentContextBudget.json" with { type: "json" };

const script = fileURLToPath(new URL("./agent-context-size.ts", import.meta.url));

it("agent context matches the committed budget", () => {
  const measured = JSON.parse(
    execFileSync(process.execPath, ["--no-warnings", script, "--json"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .at(-1)!,
  ) as {
    readonly instructions: Record<string, number>;
    readonly toolsList: { readonly modelVisibleChars: number };
  };
  expect(
    {
      claudeSystemAppendChars: measured.instructions["Claude Agent (system prompt append)"],
      codexAdditionalContextChars: measured.instructions["Codex (turn additionalContext)"],
      acpFirstPromptChars: measured.instructions["ACP (first prompt)"],
      mcpToolsModelVisibleChars: measured.toolsList.modelVisibleChars,
    },
    "Set packages/runtime/agentContextBudget.json to the measured values. Growth needs a reason in the pull request.",
  ).toEqual(budget);
}, 60_000);
