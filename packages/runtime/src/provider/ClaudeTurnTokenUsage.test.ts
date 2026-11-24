import { expect, test } from "vitest";
import { normalizeClaudeTurnTokenUsage } from "./ClaudeTurnTokenUsage.ts";

test("1h cache writes remain a subset and accumulate across steered segments", () => {
  const usage = normalizeClaudeTurnTokenUsage({ subtype: "success", usage: {
    input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_1h_input_tokens: 150, ephemeral_5m_input_tokens: 150 },
  } }, false, "completed", [{ input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 10,
    cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 25, ephemeral_5m_input_tokens: 75 } }]);
  expect(usage).toMatchObject({ inputTokens: 760, outputTokens: 15, cacheCreationTokens: 400, cacheCreation1hTokens: 175, usageStatus: "complete" });
});

test("older usage without a cache TTL does not invent one", () => {
  expect(normalizeClaudeTurnTokenUsage({ subtype: "success", usage: {
    input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 300,
  } }, false, "completed")).not.toHaveProperty("cacheCreation1hTokens");
});
