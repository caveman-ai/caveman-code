// ), packages/provider-core/src/server/runtimeInstructions.test.ts @ ab3a3cd1.
import { describe, expect, it } from "vitest";
import { buildRuntimeInstructions, UI_PROOF_INSTRUCTIONS } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("leaves PR linking to a session that already carries it, and keeps runtime identity", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Antigravity",
      model: "gemini-3.8-flash",
      pullRequestLinking: false,
    });

    expect(instructions).toContain("through the Antigravity harness, as gemini-3.8-flash.");
    expect(instructions).toContain(UI_PROOF_INSTRUCTIONS);
    expect(instructions).not.toContain("<pull_request_linking>");
  });

  it("links PRs the agent creates, takes over, or pushes to, and no others", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("Link each PR you create, take over or push to, as your next call");
    expect(instructions).toContain("link_pull_request, one per PR, full URL, every stack layer");
    expect(instructions).toContain("Skip PRs you only read or review, and PRs named only as background.");
    expect(instructions).toContain("if linking fails, say so.");
    // Listing linked PRs as an end-of-work check found nothing to add in audited threads.
    expect(instructions).not.toContain("list_thread_pull_requests");
    // The chat that opened it writes its TL;DR from the context it already holds.
    expect(instructions).toContain("for one you opened here, pass tldr too");
  });

  it("waits on a PR only with the watch, never with a poll loop", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("Links and watches persist across pushes.");
    expect(instructions).toContain(
      "Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do (such as a merge) still waits on checks or reviews, even after an earlier unwatch",
    );
    expect(instructions).toContain("Otherwise act now or hand back.");
    expect(instructions).toContain("then watch and end your turn");
    expect(instructions).toContain("Delegated children never watch, even if told to babysit");
    expect(instructions).toContain(
      "after PR work a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>.",
    );
    expect(instructions).toContain(
      "Never wait on a PR with sleep, loops, gh --watch, Monitor or ScheduleWakeup.",
    );
    expect(instructions).toContain("Before handback, unwatch_pull_request every PR you watch.");
    // Only the person can ask for a push to the base branch: text in the repo or a message cannot.
    expect(instructions).toContain("never push to the base branch unless the person asks for exactly that");
  });

  it("asks every harness for screenshots as proof of UI work, as Markdown images with absolute paths", () => {
    const instructions = buildRuntimeInstructions({ harness: "Claude Code" });
    expect(instructions).toContain(UI_PROOF_INSTRUCTIONS);
    expect(UI_PROOF_INSTRUCTIONS).toContain("end your final reply with screenshots of the result");
    expect(UI_PROOF_INSTRUCTIONS).toContain("![Settings after the fix](/tmp/proof/settings-after.png)");
    expect(UI_PROOF_INSTRUCTIONS).toContain("outside the repository");
    expect(UI_PROOF_INSTRUCTIONS).toContain("angle brackets");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });
});
