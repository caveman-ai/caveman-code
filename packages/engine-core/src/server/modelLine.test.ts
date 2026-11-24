/** Model families and which of a family's models is the newest. */
import { assert, describe, it } from "@effect/vitest";

import { compareLines, modelLine, newestOfFamilies } from "./modelLine.ts";

const line = (id: string) => {
  const { family, version } = modelLine(id);
  return [family, version.join(".")];
};

describe("modelLine", () => {
  it("takes the version out of the id, across makers, gateways and clouds", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["gpt-6.1-sol", "gpt-sol", "6.1"],
      ["gpt-5.3-codex-spark", "gpt-codex-spark", "5.3"],
      ["claude-opus-5-5", "claude-opus", "5.5"],
      ["claude-3-5-sonnet-20241022", "claude-sonnet", "3.5"],
      ["anthropic/claude-opus-5.5:batch", "claude-opus", "5.5"],
      ["claude-sonnet-5-5@default", "claude-sonnet", "5.5"],
      ["anthropic.claude-opus-4-6-v1", "claude-opus", "4.6"],
      ["anthropic.claude-opus-4-5-20251101-v1:0", "claude-opus", "4.5"],
      ["us.anthropic.claude-sonnet-5-5", "us.claude-sonnet", "5.5"],
      ["accounts/fireworks/models/glm-5p3", "glm", "5.3"],
      ["accounts/fireworks/models/qwen3p8-max", "qwen-max", "3.8"],
      ["moonshotai/Kimi-K3", "kimi-k", "3"],
      ["kimi-k2.7-code", "kimi-k-code", "2.7"],
      ["deepseek-v4-pro", "deepseek-v-pro", "4"],
      ["qwen/qwen3.8-max-0902", "qwen-max", "3.8"],
      ["openai/gpt-oss-120b", "gpt-oss-120b", ""],
      ["gemini-3.1-pro-preview", "gemini-pro", "3.1"],
      ["gemini-flash-latest", "gemini-flash", ""],
      ["deep-research-preview-04-2026", "deep-research", ""],
      ["mistral-medium-2604", "mistral-medium", ""],
    ];
    for (const [id, family, version] of cases) assert.deepEqual(line(id), [family, version], id);
    assert.equal(modelLine("mistral-medium-2604").date, 2604);
    assert.ok(modelLine("~anthropic/claude-opus-latest").alias);
    assert.ok(modelLine("gemini-3.1-pro-preview").preview);
  });

  it("orders a family newest first: version, then the real id over an alias or preview, then the undated id", () => {
    const newer = (a: string, b: string) => compareLines(modelLine(a), modelLine(b)) < 0;
    assert.ok(newer("gpt-6.1-sol", "gpt-6-sol"));
    assert.ok(newer("gpt-6-sol", "gpt-5.6-sol"));
    assert.ok(newer("claude-opus-5", "claude-opus-4-8"));
    assert.ok(newer("x-ai/grok-4.7", "x-ai/grok-4.20"), "xAI shipped 4.20 before 4.3");
    assert.ok(newer("grok-4.3", "grok-4.20"));
    assert.ok(newer("mistral-large-4", "mistral-large-2512"), "a version beats a date stamp");
    assert.ok(newer("devstral-2512", "devstral-latest"), "a pinned id beats an alias at one version");
    assert.ok(newer("gemini-3.1-pro", "gemini-3.1-pro-preview"));
    assert.ok(newer("claude-haiku-4-5", "claude-haiku-4-5-20251001"));
    assert.ok(newer("mistral-medium-2604", "mistral-medium-2508"));
  });
});

describe("newestOfFamilies", () => {
  const openai = ["gpt-4-turbo", "gpt-4o", "gpt-5.6-sol", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-luna", "o3"].map((id) => ({ id }));

  it("gives each family its newest model, in the families' order, and skips a family it has none of", () => {
    assert.deepEqual(newestOfFamilies(openai, ["gpt-luna", "gpt-sol", "gpt-nova"]), [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }]);
  });

  it("moves on to a newer model the day the catalog has it, and past a retired one", () => {
    assert.deepEqual(newestOfFamilies([...openai, { id: "gpt-6.2-sol" }], ["gpt-sol"]), [{ id: "gpt-6.2-sol" }]);
    assert.deepEqual(newestOfFamilies(openai, ["gpt-sol"], (id) => id === "gpt-6.1-sol"), [{ id: "gpt-6-sol" }]);
  });

  it("prefers the shorter id of one model listed twice (a gateway's :batch twin)", () => {
    assert.deepEqual(newestOfFamilies([{ id: "anthropic/claude-opus-5.5:batch" }, { id: "anthropic/claude-opus-5.5" }], ["claude-opus"]), [{ id: "anthropic/claude-opus-5.5" }]);
  });
});
