import { describe, expect, it } from "vitest";

import { mapCodexModelCapabilities } from "./CodexProvider.ts";
import { speedOptionFor, speedsOf, speedValueOf } from "./speedOption.ts";

const claudeOpus = [
  { id: "effort", type: "select", options: [{ id: "high", isDefault: true }] },
  { id: "fastMode", type: "boolean" },
];
const codexSol = [
  { id: "reasoningEffort", type: "select", options: [{ id: "medium", isDefault: true }] },
  { id: "serviceTier", type: "select", options: [{ id: "default", isDefault: true }, { id: "priority" }, { id: "ultrafast" }, { id: "flex" }] },
];
const sonnet = [{ id: "effort", type: "select", options: [{ id: "high", isDefault: true }] }];

describe("speedsOf", () => {
  it("lists Claude's fast mode and Codex's faster tiers, never flex or standard", () => {
    expect(speedsOf(claudeOpus)).toEqual({ speeds: ["fast"] });
    expect(speedsOf(codexSol)).toEqual({ speeds: ["fast", "ultrafast"] });
    expect(speedsOf(sonnet)).toEqual({ speeds: [] });
  });

  it("reads Codex's catalog as it lists it: Fast is its priority tier, some models start on it", () => {
    // ~/.codex/models_cache.json, 2026-10-31: every model's tier is "priority" ("fast" in the deprecated field), and
    // gpt-6.1-terra starts on it; Ultrafast reaches this app's originator only.
    const model = (id: string, defaultServiceTier: string | null) =>
      mapCodexModelCapabilities({
        additionalSpeedTiers: ["fast"],
        defaultReasoningEffort: "medium",
        description: "",
        displayName: id,
        hidden: false,
        id,
        isDefault: false,
        model: id,
        defaultServiceTier,
        serviceTiers: [
          { id: "priority", name: "Fast", description: "" },
          { id: "ultrafast", name: "Ultrafast", description: "" },
        ],
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }],
      }).optionDescriptors;
    expect(speedsOf(model("gpt-6.1-sol", null))).toEqual({ speeds: ["fast", "ultrafast"] });
    expect(speedsOf(model("gpt-6.1-terra", "priority"))).toEqual({ speeds: ["fast", "ultrafast"], defaultSpeed: "fast" });
    expect(speedOptionFor(model("gpt-6.1-sol", null), "fast")).toEqual({ option: { id: "serviceTier", value: "priority" } });
  });

  it("names a faster catalog default, and nothing for standard or flex", () => {
    const fastByDefault = [{ id: "serviceTier", type: "select", options: [{ id: "default" }, { id: "fast", isDefault: true }] }];
    const flexByDefault = [{ id: "serviceTier", type: "select", options: [{ id: "default" }, { id: "flex", isDefault: true }] }];
    expect(speedsOf(fastByDefault)).toEqual({ speeds: ["fast"], defaultSpeed: "fast" });
    expect(speedsOf(flexByDefault)).toEqual({ speeds: [] });
  });
});

describe("speedOptionFor", () => {
  it("says standard out loud on both engines", () => {
    expect(speedOptionFor(claudeOpus, "standard")).toEqual({ option: { id: "fastMode", value: false } });
    expect(speedOptionFor(codexSol, "standard")).toEqual({ option: { id: "serviceTier", value: "default" } });
  });

  it("maps a faster speed to the engine's own option", () => {
    expect(speedOptionFor(claudeOpus, "fast")).toEqual({ option: { id: "fastMode", value: true } });
    expect(speedOptionFor(codexSol, "fast")).toEqual({ option: { id: "serviceTier", value: "priority" } });
    expect(speedOptionFor(codexSol, "ultrafast")).toEqual({ option: { id: "serviceTier", value: "ultrafast" } });
  });

  it("refuses a speed the model does not offer, and sets nothing for standard on a model without speeds", () => {
    expect(speedOptionFor(claudeOpus, "ultrafast").error).toBe('has no speed "ultrafast"');
    expect(speedOptionFor(codexSol, "flex").error).toBe('has no speed "flex"');
    expect(speedOptionFor(sonnet, "fast").error).toBe('has no speed "fast"');
    expect(speedOptionFor(sonnet, "standard")).toEqual({});
  });
});

describe("speedValueOf", () => {
  it("reads either engine's option back as a speed", () => {
    expect(speedValueOf([{ id: "effort", value: "high" }, { id: "fastMode", value: true }])).toBe("fast");
    expect(speedValueOf([{ id: "fastMode", value: false }])).toBe("standard");
    expect(speedValueOf([{ id: "serviceTier", value: "default" }])).toBe("standard");
    expect(speedValueOf([{ id: "serviceTier", value: "ultrafast" }])).toBe("ultrafast");
    expect(speedValueOf([{ id: "serviceTier", value: "priority" }])).toBe("fast");
    expect(speedValueOf([{ id: "serviceTier", value: "flex" }])).toBeUndefined();
    expect(speedValueOf([{ id: "effort", value: "high" }])).toBeUndefined();
    expect(speedValueOf(undefined)).toBeUndefined();
  });
});
