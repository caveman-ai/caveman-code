// One effort per model, found under each engine's own option name.
import { describe, expect, test } from "vitest";

import { effortDescriptorOf, effortValueOf } from "./effortOption.ts";

const select = (id: string, options: Array<string> = ["low", "high"]) => ({ id, label: id, type: "select" as const, options: options.map((o) => ({ id: o, label: o })) });

describe("effort option", () => {
  test("every engine's effort list is found: Claude, Codex, Cursor, Pi, OpenCode", () => {
    for (const id of ["effort", "reasoningEffort", "reasoning", "thinking", "variant"]) expect(effortDescriptorOf([select(id)])?.id).toBe(id);
    // A boolean or another select is not an effort.
    expect(effortDescriptorOf([{ id: "fastMode", label: "Fast", type: "boolean" }, select("contextWindow")])).toBeUndefined();
    expect(effortDescriptorOf([{ id: "thinking", label: "Thinking", type: "boolean" }])).toBeUndefined();
    expect(effortDescriptorOf(undefined)).toBeUndefined();
    // The earlier name wins when a model offers two.
    expect(effortDescriptorOf([select("variant"), select("effort")])?.id).toBe("effort");
  });

  test("an ACP agent's reasoning select is the effort list under the agent's own id", () => {
    const thought = { ...select("thought_level_v2", ["minimal", "high"]), role: "reasoning" as const };
    expect(effortDescriptorOf([select("mode"), thought])?.id).toBe("thought_level_v2");
    // A named effort list still wins, and an unmarked select is not an effort.
    expect(effortDescriptorOf([thought, select("reasoningEffort")])?.id).toBe("reasoningEffort");
    expect(effortDescriptorOf([select("thought_level_v2")])).toBeUndefined();
  });

  test("a selection's effort is read back under the same names", () => {
    expect(effortValueOf([{ id: "thinking", value: "high" }])).toBe("high");
    expect(effortValueOf([{ id: "variant", value: "xhigh" }, { id: "agent", value: "build" }])).toBe("xhigh");
    expect(effortValueOf([{ id: "fastMode", value: true }])).toBeUndefined();
    expect(effortValueOf([{ id: "effort", value: "" }])).toBeUndefined();
    expect(effortValueOf(undefined)).toBeUndefined();
  });
});
