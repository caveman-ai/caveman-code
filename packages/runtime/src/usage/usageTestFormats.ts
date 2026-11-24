// ), apps/server/src/usage/usageTestFormats.ts @ ab3a3cd1.
/**
 * The built-in transcript formats by provider, for engine and cache tests.
 *
 * @module usageTestFormats
 */
import type { UsageProviderKind } from "@caveman-app/protocol";
import type { TranscriptUsageFormat } from "@caveman-app/engine-core/server/usage";
import { museUsageFormat } from "@caveman-app/provider-muse/server/usage";

import { claudeUsageFormat } from "../provider/Drivers/claudeUsage.ts";
import { codexUsageFormat } from "../provider/Drivers/codexUsage.ts";

export const TEST_FORMATS: Record<
  "claude" | "codex" | "muse",
  TranscriptUsageFormat<unknown>
> = {
  claude: claudeUsageFormat,
  codex: codexUsageFormat,
  muse: museUsageFormat,
};

export const TEST_FORMAT_MAP = new Map<UsageProviderKind, TranscriptUsageFormat<unknown>>(
  Object.entries(TEST_FORMATS) as Array<[UsageProviderKind, TranscriptUsageFormat<unknown>]>,
);
