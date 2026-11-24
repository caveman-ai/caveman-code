// Image generation is still an engine tool, not a second chat mode or a paid API integration.
// Match the native Codex name and the same tool exposed by image-generation MCP servers.
import type { ToolItem } from "./transcript-model.ts";

export { isImageGeneration } from "@caveman-app/shared/imageGeneration";

export function imagePrompt(tool: Pick<ToolItem, "input" | "result">): string | null {
  const result = record(tool.result);
  const input = record(tool.input);
  for (const value of [result.revised_prompt, result.revisedPrompt, input.prompt, input.revised_prompt]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
