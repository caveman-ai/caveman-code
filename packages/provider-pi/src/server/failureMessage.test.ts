import { describe, expect, it } from "vitest";

import { piFailureMessage } from "./failureMessage.ts";

describe("piFailureMessage", () => {
  it("names the login and how to renew it when Pi's OAuth refresh died", () => {
    const raw =
      'OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (401): {\n  "error": {\n    "message": "Your refresh token has been invalidated. Please try signing in again.",\n    "code": "refresh_token_invalidated"\n  }\n}';
    expect(piFailureMessage(raw, "Pi reported a model error.")).toBe(
      "Pi's sign-in for openai-codex expired. Run pi in a terminal and sign in again with /login.",
    );
  });

  it("keeps every other error as Pi said it, and the fallback for none", () => {
    expect(piFailureMessage("429 Too Many Requests", "x")).toBe("429 Too Many Requests");
    expect(piFailureMessage("OAuth refresh failed for anthropic: network timeout", "x")).toBe("OAuth refresh failed for anthropic: network timeout");
    expect(piFailureMessage(undefined, "Pi reported a model error.")).toBe("Pi reported a model error.");
    expect(piFailureMessage("  ", "Pi rejected the prompt.")).toBe("Pi rejected the prompt.");
  });
});
