// A model is shown by its name, never by its engine's raw id (catalog.ts modelName): the catalog's name where it knows
// the model, however the engine writes the id, else a name made from the id itself.
import { describe, expect, it } from "vitest";
import { modelName } from "./catalog";

describe("a model's name from its engine's id", () => {
  it("is the catalog's name for an id the catalog lists", () => {
    expect(modelName("claude-sonnet-5-5", "claude-agent")).toBe("Sonnet 5.5");
    expect(modelName("anthropic/claude-opus-5-5", "caveman")).toBe("Claude Opus 5.5");
    expect(modelName("gpt-5-5", "codex")).toBe("GPT-5.5");
    expect(modelName("auto", "caveman")).toBe("Auto");
  });
  it("knows the board's short name for Claude Agent", () => {
    expect(modelName("claude-sonnet-5-5", "claude")).toBe("Sonnet 5.5");
  });
  it("finds a listed model through a vendor before the id, dots for hyphens, a date or a context after it", () => {
    expect(modelName("openai/gpt-5.5")).toBe("GPT-5.5");
    expect(modelName("openai/gpt-5.5", "codex")).toBe("GPT-5.5");
    expect(modelName("claude-sonnet-5-5-20260101", "claude-agent")).toBe("Sonnet 5.5");
    expect(modelName("claude-opus-5-5[1m]", "claude-agent")).toBe("Opus 5.5");
    expect(modelName("us.anthropic.claude-sonnet-5-5-20260101-v1:0", "claude-agent")).toBe(
      "Sonnet 5.5",
    );
  });
  it("looks in the chat's own engine first, then in every engine", () => {
    // Claude Agent names it without the vendor; the Caveman engine, which runs many vendors, with it.
    expect(modelName("claude-sonnet-5-5", "claude-agent")).toBe("Sonnet 5.5");
    expect(modelName("claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(modelName("gpt-5-4-mini", "caveman")).toBe("GPT-5.4 mini");
  });
  it("keeps a name that is already a name", () => {
    expect(modelName("Opus 5.5", "claude")).toBe("Opus 5.5");
    expect(modelName("Auto", "caveman")).toBe("Auto");
    expect(modelName("GPT-6.1 Sol", "codex")).toBe("GPT-6.1 Sol");
  });
});

describe("a model the catalog does not know", () => {
  it("reads as its id without the vendor and the date, in title case", () => {
    expect(modelName("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
    expect(modelName("anthropic/claude-haiku-4-5", "caveman")).toBe("Claude Haiku 4.5");
    expect(modelName("claude-haiku-4-5-20251001", "claude")).toBe("Claude Haiku 4.5");
    expect(modelName("claude-3.5-sonnet@20241022")).toBe("Claude 3.5 Sonnet");
    expect(modelName("xai/grok-5-1-latest")).toBe("Grok 5.1");
  });
  it("writes GPT the way OpenAI does, and keeps what follows the version", () => {
    expect(modelName("gpt-5.5-codex", "codex")).toBe("GPT-5.5 Codex");
    expect(modelName("gpt-4o-2024-08-06")).toBe("GPT-4o");
    expect(modelName("o4-mini")).toBe("o4-mini");
  });
  it("puts a family's letters in capitals", () => {
    expect(modelName("zai/glm-6")).toBe("GLM 6");
    expect(modelName("moonshotai/kimi-k4")).toBe("Kimi K4");
  });
  it("never hands back a raw id, and says nothing for no model", () => {
    for (const id of [
      "anthropic/claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "gpt-5.5-codex",
      "openai/gpt-5.5",
      "chatgpt/openai/gpt-7",
    ]) {
      expect(modelName(id)).not.toMatch(/[/_]|-\d{8}$|^[a-z]/);
    }
    expect(modelName("")).toBe("");
    expect(modelName("  ")).toBe("");
  });
});
