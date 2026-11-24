import { assert, it } from "@effect/vitest";

import { CAVEMAN_CODE_BROWSER_TOOL_INSTRUCTIONS, CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS } from "@caveman-app/engine-core/server/orchestrationInstructions";
import { PULL_REQUEST_LINKING_INSTRUCTIONS } from "@caveman-app/engine-core/server/runtimeInstructions";

import { cavemanOrchestrationInstructions, isHarnessNote, runtimeInstructionBlocks, runtimeTextChoice } from "./runtimeText.ts";

it("carries the runtime's text only for the tools the credential grants", () => {
  assert.deepEqual(runtimeTextChoice(undefined), { orchestration: false, pullRequests: false, browser: false });
  assert.deepEqual(runtimeTextChoice({ browserToolsAvailable: false, capabilities: new Set(["orchestration"]) }), { orchestration: true, pullRequests: false, browser: false });
  assert.deepEqual(runtimeTextChoice({ browserToolsAvailable: false, capabilities: new Set(["orchestration", "pull-requests"]) }), { orchestration: true, pullRequests: true, browser: false });
  assert.deepEqual(runtimeTextChoice({ browserToolsAvailable: true, capabilities: new Set(["preview"]) }), { orchestration: false, pullRequests: false, browser: true });
  // A credential with no capability list predates them and grants orchestration and pull requests.
  assert.deepEqual(runtimeTextChoice({ browserToolsAvailable: true }), { orchestration: true, pullRequests: true, browser: true });
  assert.deepEqual(runtimeInstructionBlocks({ orchestration: false, pullRequests: false, browser: false }), []);
  const all = runtimeInstructionBlocks({ orchestration: true, pullRequests: true, browser: true });
  assert.equal(all.length, 3);
  // The pull request block tells the engine to register each pull request, which starts its review guide.
  assert.equal(all[1], PULL_REQUEST_LINKING_INSTRUCTIONS);
  assert.include(all[1], "link_pull_request");
  assert.equal(all[2], CAVEMAN_CODE_BROWSER_TOOL_INSTRUCTIONS);
});

it("drops T3's paragraphs about other harnesses' transports and keeps every other byte", () => {
  const text = cavemanOrchestrationInstructions();
  assert.notInclude(text, "ACP fallback");
  assert.notInclude(text, "may load late");
  assert.include(text, "delegate_task");
  assert.include(text, "### The repo's Cloud setup");
  const kept = CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS.split("\n\n").filter((paragraph) => !paragraph.startsWith("Caveman Code tools may load late"));
  assert.equal(text, kept.join("\n\n"));
  assert.equal(runtimeInstructionBlocks({ orchestration: true, pullRequests: false, browser: false })[0], text);
  // A re-port that rewords them fails here instead of shipping them again.
  assert.throws(() => cavemanOrchestrationInstructions("## Caveman Code orchestration\n\nnothing else"), /paragraph not found/);
});

it("knows the engine's own note from what the person said", () => {
  assert.isTrue(isHarnessNote("[harness note] Your last 5 requests (bash python x5) changed no workspace file"));
  assert.isFalse(isHarnessNote("please add a [harness note] section"));
});
