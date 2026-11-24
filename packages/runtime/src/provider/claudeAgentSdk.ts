// The Claude Agent SDK's module (sdk.mjs, 1.3 MB of source) is imported on first use, not at the runtime's start:
// a runtime whose Claude is not installed, or not used yet, never holds it. Type imports stay static.
import type * as ClaudeAgentSdk from "@anthropic-ai/claude-agent-sdk";

let loading: Promise<typeof ClaudeAgentSdk> | undefined;

/** The SDK: imported by the first call, shared after. A failed import is tried again on the next call. */
export const loadClaudeAgentSdk = (): Promise<typeof ClaudeAgentSdk> =>
  (loading ??= import("@anthropic-ai/claude-agent-sdk").catch((cause: unknown) => {
    loading = undefined;
    throw cause;
  }));
