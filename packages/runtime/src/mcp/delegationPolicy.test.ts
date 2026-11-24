import { describe, expect, it } from "vitest";

import { anchorModel, defaultChildModel, delegationRefusal, resolveChildSelection } from "./delegationPolicy.ts";

const provider = (...slugs: string[]) => ({ models: slugs.map((slug) => ({ slug })) }) as never;

describe("agents at once", () => {
  // Settings > Agents: eight at once, two levels deep, a thousand tokens.
  const settings = { maxDepth: 2, maxConcurrent: 8, treeTokenCeiling: 1000 };
  const full = (atOnce: number) => `Not delegated: ${atOnce} delegated agents are already working in this task. Wait for one to finish (its result wakes you), then delegate again.`;

  it("Settings' number is how many work at once under a chat, and the refusal says it", () => {
    expect(delegationRefusal(settings, { callerDepth: 0, running: 7, tokens: 0 })).toBeUndefined();
    expect(delegationRefusal(settings, { callerDepth: 0, running: 8, tokens: 0 })).toBe(full(8));
    expect(delegationRefusal({ ...settings, maxConcurrent: 32 }, { callerDepth: 0, running: 31, tokens: 0 })).toBeUndefined();
    expect(delegationRefusal({ ...settings, maxConcurrent: 32 }, { callerDepth: 0, running: 32, tokens: 0 })).toBe(full(32));
  });

  it("how deep agents nest and the tree's token ceiling hold beside it", () => {
    expect(delegationRefusal(settings, { callerDepth: 2, running: 0, tokens: 0 })).toContain("at most 2 levels");
    expect(delegationRefusal(settings, { callerDepth: 0, running: 0, tokens: 1000 })).toContain("used their budget");
  });
});

describe("child model selection", () => {
  const anthropic = provider("anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5", "openai/gpt-6-luna");

  it("resolves a class within the parent model's provider and family", () => {
    const resolve = (model: string) => defaultChildModel({ provider: anthropic, parentModel: "anthropic/claude-opus-5-5", agentType: { model } });
    expect(resolve("fast")).toBe("anthropic/claude-haiku-5-5");
    expect(resolve("base")).toBe("anthropic/claude-sonnet-5-5");
    expect(resolve("frontier")).toBe("anthropic/claude-opus-5-5");
    // An alias still works, an unknown family gets no class.
    expect(resolve("haiku")).toBe("anthropic/claude-haiku-5-5");
    expect(defaultChildModel({ provider: provider("deepseek/deepseek-v4.1-flash"), parentModel: "deepseek/deepseek-v4.1-flash", agentType: { model: "fast" } })).toBeUndefined();
  });

  it("on the parent's engine resolves like defaultChildModel; another engine's child takes only an exact id", () => {
    expect(resolveChildSelection({ provider: anthropic, parentModel: "anthropic/claude-sonnet-5-5", sameEngine: true, wanted: "frontier" })).toBe("anthropic/claude-opus-5-5");
    expect(resolveChildSelection({ provider: anthropic, parentModel: "anthropic/claude-sonnet-5-5", sameEngine: true, wanted: undefined })).toBeUndefined();
    expect(resolveChildSelection({ provider: anthropic, parentModel: "x", sameEngine: false, wanted: "frontier" })).toBeUndefined();
    expect(resolveChildSelection({ provider: anthropic, parentModel: "x", sameEngine: false, wanted: "openai/gpt-6-luna" })).toBe("openai/gpt-6-luna");
  });

  it("under an Auto lead, a class anchors on the engine's first model of a family the table knows (as steps do)", () => {
    const auto = provider("caveman-auto", "anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5", "anthropic/claude-opus-5-5");
    expect(anchorModel(auto, "caveman-auto")).toBe("anthropic/claude-sonnet-5-5");
    expect(anchorModel(auto, "auto")).toBe("anthropic/claude-sonnet-5-5");
    expect(anchorModel(auto, "anthropic/claude-opus-5-5")).toBe("anthropic/claude-opus-5-5");
    expect(defaultChildModel({ provider: auto, parentModel: "caveman-auto", agentType: { model: "fast" } })).toBe("anthropic/claude-haiku-5-5");
    expect(resolveChildSelection({ provider: auto, parentModel: "caveman-auto[1m]", sameEngine: true, wanted: "frontier" })).toBe("anthropic/claude-opus-5-5");
    expect(defaultChildModel({ provider: auto, parentModel: "auto", agentType: { model: "haiku" } })).toBe("anthropic/claude-haiku-5-5");
  });
});
