// ), packages/provider-core/src/server/orchestrationInstructions.test.ts @ ab3a3cd1.
import { assert, describe, it } from "@effect/vitest";

import {
  CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS,
  cavemanAcpPromptWithInstructions,
  cavemanOrchestrationPromptForFirstRun,
  cavemanOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS, "Subagents: `delegate_task` for another provider's model");
    assert.include(CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS, "make top-level threads, only when the user asks for a new thread");
    assert.include(CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS, '"subagent", "delegate" and "parallel" never mean one');
    assert.include(CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS, "is a new `delegate_task`");
    assert.include(CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS, "never a `thread_send`");
    assert.include(
      CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS,
      "any background agent (never a background `Agent`)",
    );
  });

  it("leaves the model to Auto unless the user names one, and never polls a delegate", () => {
    assert.include(CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS, "leave `target` out unless the user names a model");
    assert.include(CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS, "Follow a running delegate's `next`; never poll it");
    assert.include(CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS, "### Messaging between threads");
    assert.include(CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS, "`expectReply:true`, then end your turn");
    // Schedules, workspaces and examples live in the tools' own descriptions now.
    assert.notInclude(CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = cavemanOrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasCavemanMcp: true,
    });

    assert.include(injected, "<caveman_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      cavemanOrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasCavemanMcp: true }),
      prompt,
    );
    assert.equal(
      cavemanOrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasCavemanMcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(cavemanOrchestrationSystemPrompt(false), undefined);
    assert.equal(cavemanOrchestrationSystemPrompt(true), CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = cavemanAcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasCavemanMcp: true },
    });

    assert.include(injected, "Caveman Code interaction mode: Default");
    assert.include(injected, "Caveman Code browser");
    assert.include(injected, "Caveman Code orchestration");
    // Only ACP agents get the terminal transport for tools they fail to expose.
    assert.include(injected, "ACP fallback:");
    assert.notInclude(CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS, "ACP fallback");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasCavemanMcp: true } as const;

    assert.equal(
      cavemanAcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      cavemanAcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, hasCavemanMcp: false },
        previousState: defaultState,
      }),
      "Caveman Code interaction mode: Default",
    );
    const withoutMcp = cavemanAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasCavemanMcp: false },
    });
    assert.include(withoutMcp, "Caveman Code interaction mode: Default");
    assert.notInclude(withoutMcp, "Caveman Code browser");
    assert.notInclude(withoutMcp, "Caveman Code orchestration");
  });
});
