import { describe, expect, it } from "vitest";
import { costLevel, costPosition, modelFacts, runAt, smartsLevel, tokensShort, usd } from "./model-facts";

describe("model facts", () => {
  it("finds a model however an engine names it", () => {
    const opus = modelFacts("claude-opus-5-5");
    expect(opus?.runs.medium).toEqual([51, 1.34]);
    expect(opus?.price).toEqual([4, 0.2, 20]);
    for (const id of ["anthropic/claude-opus-5-5", "caveman/anthropic/claude-opus-5-5", "claude-opus-5-5[1m]", "Claude-Opus-5-5"]) expect(modelFacts(id)).toBe(opus);
    // Codex says gpt-6.1-sol; Artificial Analysis spells it gpt-6-1-sol.
    expect(modelFacts("chatgpt/openai/gpt-6.1-sol")?.runs.high).toEqual([50, 0.32]);
    expect(modelFacts("auto")).toBeUndefined();
    expect(modelFacts("toString")).toBeUndefined();
  });

  it("answers an effort it never measured with nothing, unless it measured one unnamed effort", () => {
    expect(runAt(modelFacts("claude-opus-5-5")!, "ultracode")).toBeUndefined();
    expect(runAt(modelFacts("gemini-4-argon")!, "low")).toBeUndefined();
    const pro = modelFacts("gemini-3.1-pro-preview")!;
    expect(runAt(pro, "low")).toEqual([30, 1.3]);
    expect(runAt(pro, undefined)).toEqual([30, 1.3]);
  });

  it("puts every cost on one log scale, a cent to ten dollars", () => {
    expect(costPosition(0.01)).toBe(0);
    expect(costPosition(10)).toBe(1);
    expect(costPosition(0.1)).toBeCloseTo(1 / 3);
    expect(costPosition(0.001)).toBe(0);
    expect(costPosition(100)).toBe(1);
  });

  it("formats money and context the way the card reads", () => {
    expect([usd(4), usd(0.2), usd(1.34), usd(0.0045), usd(20)]).toEqual(["$4", "$0.2", "$1.34", "$0.0045", "$20"]);
    expect([tokensShort(1_000_000), tokensShort(922_000), tokensShort(1_048_576)]).toEqual(["1M", "922K", "1.05M"]);
  });

  it("reads smarts in bars and cost in dollars, on bands every row shares", () => {
    // Haiku, Sonnet, Fable and Opus at medium: 34, 41, 49, 51.
    expect([34, 41, 49, 51, 58, 6].map(smartsLevel)).toEqual([2, 3, 4, 4, 5, 0]);
    // $0.05, $0.48, $1.34, $2.98 a task.
    expect([0.05, 0.48, 1.34, 2.98].map(costLevel)).toEqual([1, 2, 3, 4]);
  });
});
