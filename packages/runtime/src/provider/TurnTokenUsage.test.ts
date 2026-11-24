// ), apps/server/src/provider/TurnTokenUsage.test.ts @ ab3a3cd1.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vitest";
import { claudeTurnWebSearches, normalizeClaudeTurnTokenUsage } from "./ClaudeTurnTokenUsage.ts";
import {
  accumulateCodexTurnTokenUsage,
  completeCodexTurnTokenUsage,
  getCodexTurnAccumulator,
  makeCodexTurnTokenUsageState,
} from "./CodexTurnTokenUsage.ts";

const breakdown = (input: number, cached: number, output: number) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
  reasoningOutputTokens: 0,
});
const update = (total: ReturnType<typeof breakdown>, last = total) => ({
  total,
  last,
  modelContextWindow: 200_000,
});

describe("billable native turn usage", () => {
  it("adds each Codex response once and excludes the prior resumed history", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "turn";
    const first = update(breakdown(1010, 505, 102), breakdown(10, 5, 2));
    accumulateCodexTurnTokenUsage(state, "turn", first);
    accumulateCodexTurnTokenUsage(state, "turn", first);
    accumulateCodexTurnTokenUsage(
      state,
      "turn",
      update(breakdown(1030, 515, 108), breakdown(20, 10, 6)),
    );
    expect(completeCodexTurnTokenUsage(state, "turn", true)).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: false,
      inputTokens: 30,
      cachedInputTokens: 15,
      outputTokens: 8,
      reasoningTokens: 0,
    });
  });

  it("keeps previous responses when compaction resets Codex cumulative counters", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "turn";
    accumulateCodexTurnTokenUsage(state, "turn", update(breakdown(100, 40, 20)));
    accumulateCodexTurnTokenUsage(state, "turn", update(breakdown(20, 5, 3)));
    getCodexTurnAccumulator(state, "turn").hasSubagents = true;
    expect(completeCodexTurnTokenUsage(state, "turn", false)).toMatchObject({
      usageStatus: "partial",
      hasSubagents: true,
      inputTokens: 120,
      cachedInputTokens: 45,
      outputTokens: 23,
    });
  });

  it("does not bill late Codex updates against the next active turn", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "next";
    accumulateCodexTurnTokenUsage(state, "previous", update(breakdown(100, 10, 20)));
    accumulateCodexTurnTokenUsage(
      state,
      "next",
      update(breakdown(104, 12, 21), breakdown(4, 2, 1)),
    );
    expect(completeCodexTurnTokenUsage(state, "next", true)).toMatchObject({
      inputTokens: 4,
      outputTokens: 1,
    });
    expect(completeCodexTurnTokenUsage(state, "missing", false).usageStatus).toBe("unavailable");
  });

  it("counts Claude cached input inside total input and bounds thinking output", () => {
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "success",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
            output_tokens: 20,
            output_tokens_details: { thinking_tokens: 25 },
          },
        },
        true,
        "completed",
      ),
    ).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: true,
      inputTokens: 150,
      cachedInputTokens: 40,
      cacheCreationTokens: 10,
      outputTokens: 20,
      reasoningTokens: 20,
    });
  });

  it("does not turn a zeroed Claude crash result into a measured zero-cost turn", () => {
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "error_during_execution",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
        false,
        "failed",
      ).usageStatus,
    ).toBe("unavailable");
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "success",
          usage: {
            input_tokens: 4,
            output_tokens: 2,
          },
        },
        false,
        "interrupted",
      ),
    ).toMatchObject({ usageStatus: "partial", inputTokens: 4, outputTokens: 2 });
  });

  it.each(["failed", "interrupted", "completed"] as const)(
    "retains measured Claude steering usage as partial after %s without final usage",
    (status) => {
      expect(
        normalizeClaudeTurnTokenUsage(
          status === "completed" ? { subtype: "success" } : undefined,
          true,
          status,
          [
            { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 20 },
            { input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 3 },
          ],
        ),
      ).toEqual({
        usageStatus: "partial",
        usageScope: "main_agent",
        hasSubagents: true,
        inputTokens: 147,
        cachedInputTokens: 42,
        outputTokens: 23,
      });
    },
  );

  it.each([undefined, null, {}])(
    "keeps unavailable Claude usage unavailable without measured segments (%s)",
    (usage) => {
      expect(
        normalizeClaudeTurnTokenUsage({ subtype: "success", usage }, false, "completed")
          .usageStatus,
      ).toBe("unavailable");
    },
  );

  it("retains measured thinking tokens without a final result", () => {
    expect(
      normalizeClaudeTurnTokenUsage(undefined, false, "failed", [
        { input_tokens: 4, output_tokens: 3, output_tokens_details: { thinking_tokens: 2 } },
      ]),
    ).toMatchObject({
      usageStatus: "partial",
      inputTokens: 4,
      outputTokens: 3,
      reasoningTokens: 2,
    });
  });

  it.each([undefined, null])(
    "retains earlier cache counts when a steering segment reports %s",
    (cache) => {
      expect(
        normalizeClaudeTurnTokenUsage(undefined, false, "failed", [
          { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 20 },
          { input_tokens: 5, cache_read_input_tokens: cache, output_tokens: 3 },
        ]),
      ).toMatchObject({
        usageStatus: "partial",
        inputTokens: 145,
        cachedInputTokens: 40,
        outputTokens: 23,
      });
    },
  );

  it.each(["cache_read_input_tokens", "cache_creation_input_tokens"])(
    "keeps Claude usage partial when the final %s is invalid",
    (field) => {
      expect(
        normalizeClaudeTurnTokenUsage(
          { subtype: "success", usage: { input_tokens: 5, output_tokens: 3, [field]: -1 } },
          false,
          "completed",
          [{ input_tokens: 100, output_tokens: 20, [field]: 40 }],
        ),
      ).toMatchObject({ usageStatus: "partial", inputTokens: 145, outputTokens: 23 });
    },
  );

  it("adds Claude steering segments to the final measured result once", () => {
    expect(
      normalizeClaudeTurnTokenUsage(
        { subtype: "success", usage: { input_tokens: 5, output_tokens: 3 } },
        false,
        "completed",
        [{ input_tokens: 4, output_tokens: 2 }],
      ),
    ).toMatchObject({ usageStatus: "complete", inputTokens: 9, outputTokens: 5 });
  });
});

describe("Claude web searches per turn", () => {
  // The recorded web_search fixture's result: the search ran in a side call on Haiku, so the main model's
  // server_tool_use says 0 and only modelUsage counts it.
  const recorded = NodeFS.readFileSync(
    new URL("../orchestration-v2/testkit/fixtures/web_search/claude_transcript.ndjson", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { readonly frame?: { readonly type?: string; readonly usage?: unknown; readonly modelUsage?: unknown } })
    .find((entry) => entry.frame?.type === "result")!.frame!;
  const modelUsage = (searches: Record<string, number>) =>
    Object.fromEntries(Object.entries(searches).map(([model, webSearchRequests]) => [model, { inputTokens: 1, outputTokens: 1, webSearchRequests }]));

  it("counts every model's searches from modelUsage, not the main model's server_tool_use", () => {
    expect(recorded.usage).toMatchObject({ server_tool_use: { web_search_requests: 0 } });
    expect(claudeTurnWebSearches(recorded, 0)).toEqual({ turn: 1, processSearches: 1 });
  });

  it("counts a later turn of the same CLI process as the growth since its last result", () => {
    const second = { usage: {}, modelUsage: modelUsage({ "claude-sonnet-4-6": 1, "claude-haiku-4-5": 3 }) };
    expect(claudeTurnWebSearches(second, 1)).toEqual({ turn: 3, processSearches: 4 });
    expect(claudeTurnWebSearches({ modelUsage: modelUsage({ "claude-haiku-4-5": 4 }) }, 4)).toEqual({ turn: 0, processSearches: 4 });
  });

  it("falls back to the turn's own server_tool_use, its steered segments' included, without modelUsage", () => {
    const usage = (web_search_requests: number) => ({ input_tokens: 1, server_tool_use: { web_search_requests, web_fetch_requests: 0 } });
    expect(claudeTurnWebSearches({ usage: usage(2) }, 5, [usage(1)])).toEqual({ turn: 3, processSearches: 5 });
    // Neither says: unknown, not zero.
    expect(claudeTurnWebSearches({ usage: { input_tokens: 1 } }, 5)).toEqual({ turn: undefined, processSearches: 5 });
  });

  it("rides along on the turn's usage as a count only, whatever the tokens' status", () => {
    const result = { subtype: "success" as const, usage: { input_tokens: 10, output_tokens: 2 } };
    expect(normalizeClaudeTurnTokenUsage(result, false, "completed", [], 2)).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: false,
      inputTokens: 10,
      outputTokens: 2,
      webSearches: 2,
    });
    expect(normalizeClaudeTurnTokenUsage(result, false, "completed", [], 0)).not.toHaveProperty("webSearches");
    expect(normalizeClaudeTurnTokenUsage(result, false, "completed")).not.toHaveProperty("webSearches");
    expect(normalizeClaudeTurnTokenUsage(undefined, false, "failed", [], 1)).toMatchObject({ usageStatus: "unavailable", webSearches: 1 });
  });
});
