import { describe, expect, it } from "vitest";

import { classTable, familyOf, isModelClass, modelForClass } from "./classes.ts";

const provider = (...slugs: string[]) => ({ models: slugs.map((slug) => ({ slug })) }) as never;

describe("model classes", () => {
  it("resolves a class within the engine model's provider prefix and family", () => {
    const p = provider("openrouter/anthropic/claude-haiku-5-5", "anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5");
    expect(modelForClass({ provider: p, model: "anthropic/claude-opus-5-5", modelClass: "fast" })).toBe("anthropic/claude-haiku-5-5");
    expect(modelForClass({ provider: p, model: "anthropic/claude-opus-5-5", modelClass: "base" })).toBe("anthropic/claude-sonnet-5-5");
    expect(modelForClass({ provider: p, model: "anthropic/claude-sonnet-5-5", modelClass: "frontier" })).toBe("anthropic/claude-opus-5-5");
  });

  it("never crosses families: a GPT engine gets GPT classes", () => {
    const p = provider("gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "claude-haiku-5-5");
    expect(classTable({ provider: p, model: "gpt-6.1-sol" })).toEqual({ fast: "gpt-6-luna", base: "gpt-6-astra", frontier: "gpt-6.1-sol", source: "GPT class table" });
  });

  it("leaves a class out when the provider lists no such model", () => {
    expect(classTable({ provider: provider("claude-opus-5-5", "claude-haiku-5-5"), model: "claude-opus-5-5" })).toEqual({
      fast: "claude-haiku-5-5",
      frontier: "claude-opus-5-5",
      source: "Claude class table",
    });
  });

  it("knows no class for an unknown family, and says what happens instead", () => {
    expect(familyOf("deepseek/deepseek-v4.1-flash")).toBeUndefined();
    expect(modelForClass({ provider: provider("deepseek/deepseek-v4.1-flash"), model: "deepseek/deepseek-v4.1-flash", modelClass: "fast" })).toBeUndefined();
    expect(classTable({ provider: provider(), model: "deepseek/deepseek-v4.1-flash" }).source).toMatch(/no class table/);
  });

  it("recognizes the three class names only", () => {
    expect(["fast", "base", "frontier"].every(isModelClass)).toBe(true);
    expect(isModelClass("opus")).toBe(false);
    expect(isModelClass(undefined)).toBe(false);
  });
});
