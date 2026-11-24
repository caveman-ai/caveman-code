import { describe, expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { cavemanRuntimeTools } from "./cavemanRuntimeTools.ts";
import { ComputerTool } from "./toolkits/computer/tools.ts";
import { PreviewSnapshotTool } from "./toolkits/preview/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";

describe("cavemanRuntimeTools", () => {
  it("declares the image tools as the runtime's MCP server serves them", () => {
    const images = cavemanRuntimeTools.images!;
    expect(images.browser.map((tool) => tool.tool)).toEqual(["preview_snapshot"]);
    expect(images.desktop.map((tool) => tool.tool)).toEqual(["computer"]);
    // The same description and schema the server lists, so the declaration never drifts from it.
    expect(images.browser[0]!.input).toEqual(Tool.getJsonSchema(PreviewSnapshotTool));
    expect(images.desktop[0]!.description).toEqual(Tool.getDescription(ComputerTool));
    // computer's wait holds up to 60 s before its screenshot.
    expect(images.desktop[0]!.timeoutMs).toBeGreaterThan(61_000);
  });

  it("declares the automation tools as the orchestrator toolkit serves them", () => {
    const names = ["automation_check", "automation_explain", "automation_run", "automation_templates"];
    const declared = cavemanRuntimeTools.waiting.filter((tool) => names.includes(tool.tool));
    expect(declared.map((tool) => tool.tool)).toEqual(names);
    for (const tool of declared) {
      const served = OrchestratorToolkit.tools[tool.tool as keyof typeof OrchestratorToolkit.tools];
      expect(tool.input).toEqual(Tool.getJsonSchema(served));
      expect(tool.description).toEqual(Tool.getDescription(served));
    }
    // Every request carries them (B19): one line each, about 400 tokens for all four (979 before).
    for (const tool of declared) expect(tool.description.length, tool.tool).toBeLessThanOrEqual(120);
    expect(JSON.stringify(declared.map((tool) => ({ name: tool.tool, description: tool.description, input: tool.input }))).length).toBeLessThanOrEqual(1700);
  });
});
