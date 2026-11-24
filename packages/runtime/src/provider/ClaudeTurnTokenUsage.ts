// ), apps/server/src/provider/ClaudeTurnTokenUsage.ts @ ab3a3cd1.
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRuntimeTurnStatus, TurnTokenUsage } from "@caveman-app/protocol";

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

const BILLED_USAGE_FIELDS = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
] as const;

// Adds up a count over the final result and the segments a steer ended before
// it. A count the final result lacks keeps the earlier segments' measured
// counts (a steered query can exit without one); only when no segment
// measured it does it stay missing. normalizeClaudeTurnTokenUsage then marks
// such a turn partial, not complete.
function addKnownCount(finalCount: unknown, earlierCounts: ReadonlyArray<unknown>): unknown {
  const counts = [finalCount, ...earlierCounts]
    .map(finiteNonNegativeInteger)
    .filter((count) => count !== undefined);
  return counts.length === 0 ? finalCount : counts.reduce((sum, count) => sum + count, 0);
}

// A steer ends the running segment with an aborted result, and the SDK scopes
// each result's usage to its own segment. Adds the billed counts of those
// earlier segments onto the final result's usage. Other usage fields describe
// the final result only and are left as they are.
function withEarlierSegmentUsage(
  usage: Record<string, unknown>,
  earlierSegmentUsage: ReadonlyArray<unknown>,
): Record<string, unknown> {
  if (earlierSegmentUsage.length === 0) return usage;
  const segments = earlierSegmentUsage.map((segment) => (segment ?? {}) as Record<string, unknown>);
  const total = { ...usage };
  for (const field of BILLED_USAGE_FIELDS) {
    total[field] = addKnownCount(
      usage[field],
      segments.map((segment) => segment[field]),
    );
  }
  const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
  total.cache_creation = {
    ...cacheCreation,
    ephemeral_1h_input_tokens: addKnownCount(
      cacheCreation?.ephemeral_1h_input_tokens,
      segments.map((segment) => (segment.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens),
    ),
  };
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  total.output_tokens_details = {
    ...outputDetails,
    thinking_tokens: addKnownCount(
      outputDetails?.thinking_tokens,
      segments.map(
        (segment) =>
          (segment.output_tokens_details as Record<string, unknown> | undefined)?.thinking_tokens,
      ),
    ),
  };
  return total;
}

/** Every model's web searches so far in one CLI process (`modelUsage` is cumulative per process), when it says. */
function processWebSearches(modelUsage: unknown): number | undefined {
  if (modelUsage === null || typeof modelUsage !== "object") return undefined;
  const counts = Object.values(modelUsage).flatMap((entry) => {
    const count = finiteNonNegativeInteger((entry as Record<string, unknown> | null)?.webSearchRequests);
    return count === undefined ? [] : [count];
  });
  return counts.length === 0 ? undefined : counts.reduce((sum, count) => sum + count, 0);
}

const serverToolWebSearches = (usage: unknown): number | undefined =>
  finiteNonNegativeInteger(
    ((usage as Record<string, unknown> | null | undefined)?.server_tool_use as Record<string, unknown> | null | undefined)
      ?.web_search_requests,
  );

/** The window each model in the SDK's `modelUsage` is measured against, as Claude Code resolved it. */
export function claudeReportedContextWindows(modelUsage: unknown): ReadonlyMap<string, number> {
  const windows = new Map<string, number>();
  if (typeof modelUsage !== "object" || modelUsage === null) return windows;
  for (const [model, entry] of Object.entries(modelUsage as Record<string, unknown>)) {
    const window = finiteNonNegativeInteger(
      (entry as Record<string, unknown> | null)?.contextWindow,
    );
    if (window !== undefined && window > 0) windows.set(model, window);
  }
  return windows;
}

/**
 * The web searches one turn ran, and its CLI process's running count to measure the next turn from.
 * Claude Code's WebSearch runs each search in a side call on a small model, so the turn's own
 * `usage.server_tool_use.web_search_requests` (its main model's calls) stays 0 for them; each model's
 * `modelUsage.webSearchRequests` counts every call the process made, subagents' included. Without
 * modelUsage, the turn's own server_tool_use, its steered segments' included.
 */
export function claudeTurnWebSearches(
  result: { readonly usage?: unknown; readonly modelUsage?: unknown },
  processSearchesBefore: number,
  earlierSegmentUsage: ReadonlyArray<unknown> = [],
): { readonly turn: number | undefined; readonly processSearches: number } {
  const processSearches = processWebSearches(result.modelUsage);
  if (processSearches !== undefined) {
    // A process's count only grows; the max guards a CLI that ever reset it.
    return { turn: Math.max(0, processSearches - processSearchesBefore), processSearches };
  }
  const counts = [result.usage, ...earlierSegmentUsage].flatMap((usage) => {
    const count = serverToolWebSearches(usage);
    return count === undefined ? [] : [count];
  });
  return {
    turn: counts.length === 0 ? undefined : counts.reduce((sum, count) => sum + count, 0),
    processSearches: processSearchesBefore,
  };
}

/**
 * Normalizes a Claude turn's billed usage from its final SDK result.
 * `earlierSegmentUsage` holds the usage of results a steer ended before the
 * final one, oldest first. `webSearches` (claudeTurnWebSearches) rides along
 * as a count only: their price is inside the turn's cost.
 */
export function normalizeClaudeTurnTokenUsage(
  result: { readonly subtype: SDKResultMessage["subtype"]; readonly usage?: unknown } | undefined,
  hasSubagents: boolean,
  terminalStatus: ProviderRuntimeTurnStatus,
  earlierSegmentUsage: ReadonlyArray<unknown> = [],
  webSearches?: number,
): TurnTokenUsage {
  const searched = webSearches !== undefined && webSearches > 0 ? { webSearches } : {};
  const finalUsage = result?.usage as Record<string, unknown> | undefined;
  // A final result without usage still keeps what its steered segments measured.
  const usage = withEarlierSegmentUsage(finalUsage ?? {}, earlierSegmentUsage);

  const uncachedInputTokens = finiteNonNegativeInteger(usage.input_tokens);
  const cachedInputTokens = finiteNonNegativeInteger(usage.cache_read_input_tokens);
  const cacheCreationTokens = finiteNonNegativeInteger(usage.cache_creation_input_tokens);
  const cacheCreation1hTokens = finiteNonNegativeInteger((usage.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens);
  const rawOutputTokens = finiteNonNegativeInteger(usage.output_tokens);
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  const thinkingTokens = finiteNonNegativeInteger(outputDetails?.thinking_tokens);
  const cachedInputContribution = usage.cache_read_input_tokens == null ? 0 : cachedInputTokens;
  const cacheCreationContribution =
    usage.cache_creation_input_tokens == null ? 0 : cacheCreationTokens;
  const inputTokens =
    uncachedInputTokens !== undefined &&
    cachedInputContribution !== undefined &&
    cacheCreationContribution !== undefined
      ? uncachedInputTokens + cachedInputContribution + cacheCreationContribution
      : undefined;
  const hasKnownUsage =
    uncachedInputTokens !== undefined ||
    cachedInputTokens !== undefined ||
    cacheCreationTokens !== undefined ||
    rawOutputTokens !== undefined;
  const hasPositiveUsage =
    (uncachedInputTokens ?? 0) +
      (cachedInputTokens ?? 0) +
      (cacheCreationTokens ?? 0) +
      (rawOutputTokens ?? 0) >
    0;

  if (!hasKnownUsage || (result?.subtype !== "success" && !hasPositiveUsage)) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents,
      ...searched,
    };
  }

  const commonUsage = {
    usageScope: "main_agent",
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(cacheCreation1hTokens !== undefined ? { cacheCreation1hTokens } : {}),
    ...(thinkingTokens !== undefined && rawOutputTokens !== undefined
      ? { reasoningTokens: Math.min(rawOutputTokens, thinkingTokens) }
      : {}),
    hasSubagents,
    ...searched,
  } as const;
  if (
    terminalStatus === "completed" &&
    result?.subtype === "success" &&
    // Complete only when the final result measured its own segment too.
    finiteNonNegativeInteger(finalUsage?.input_tokens) !== undefined &&
    finiteNonNegativeInteger(finalUsage?.output_tokens) !== undefined &&
    inputTokens !== undefined &&
    rawOutputTokens !== undefined &&
    BILLED_USAGE_FIELDS.every(
      (field) =>
        finalUsage?.[field] == null || finiteNonNegativeInteger(finalUsage[field]) !== undefined,
    )
  ) {
    return {
      ...commonUsage,
      usageStatus: "complete",
      inputTokens,
      outputTokens: rawOutputTokens,
    };
  }
  return {
    ...commonUsage,
    usageStatus: "partial",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(rawOutputTokens !== undefined ? { outputTokens: rawOutputTokens } : {}),
  };
}
