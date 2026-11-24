// The fixed text the app adds to every engine request, held to a budget: it is paid on every call of every
// chat (cached or not), so growth has to be a decision, not drift. Like Caveman Cloud's agent-surface budgets
//. Raise a budget only with the reason in the commit.
import { CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS } from "@caveman-app/engine-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@caveman-app/engine-core/server/runtimeInstructions";
import { expect, test } from "vitest";

import { CO_AUTHOR_INSTRUCTION } from "../git/coAuthor.ts";
import { buildCodexAdditionalContext } from "../provider/CodexDeveloperInstructions.ts";

const bytes = (...parts: ReadonlyArray<string>) => parts.reduce((sum, part) => sum + Buffer.byteLength(part, "utf8"), 0);

/**
 * Bytes (about 4 per token). Measured 2026-10-28, after the instruction cut: Claude Agent 6,411, Codex 8,392
 * (2026-10-17: 9,689 and 13,621). 2026-11-12: Claude Agent 7,661, from what agents were told since (register_preview
 * and UI proof, request_secret, delegate_task, waiting on a deploy, and landing through a pull request, a repository's
 * own landing rule included): its budget 7,700.
 */
const BUDGET = { "claude-agent": 7_700, codex: 9_500 } as const;

test("Claude Agent's appended system prompt: the runtime's info, the orchestration tools and Caveman's attribution", () => {
  const appended = bytes(buildRuntimeInstructions({ harness: "Claude Code" }), CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS, CO_AUTHOR_INSTRUCTION);
  expect(appended, `Claude Agent's fixed prompt is ${appended} bytes; budget ${BUDGET["claude-agent"]}`).toBeLessThanOrEqual(BUDGET["claude-agent"]);
});

test("Codex's turn context, every tool on, and Caveman's attribution", () => {
  const context = buildCodexAdditionalContext({ model: "gpt-5.4", reasoningEffort: "medium" }, { browser: true, device: true });
  const added = bytes(...Object.values(context).map((entry) => entry.value), CO_AUTHOR_INSTRUCTION);
  expect(added, `Codex's fixed context is ${added} bytes; budget ${BUDGET.codex}`).toBeLessThanOrEqual(BUDGET.codex);
});
