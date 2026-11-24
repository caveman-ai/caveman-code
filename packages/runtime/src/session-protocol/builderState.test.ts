// A failed builder's row says the chat's own sentence, never an engine's or a driver's: the sentence is written in
// one place (modelConnections.ts) and found again here in the engine's error, so the two must stay one wording.
import { expect, test } from "vitest";

import { noConnectionMessage, noConnectionNote } from "../cloudLink/modelConnections.ts";
import { failedWhy } from "./builderState.ts";

test("a builder that failed because nothing connected runs its agent says the chat's own first sentence, for every agent, on a Mac and in Cloud", () => {
  const cases = [
    ["claude-agent", undefined],
    ["codex", undefined],
    ["caveman", "openrouter"],
    ["caveman", "anthropic"],
    ["caveman", undefined],
  ] as const;
  for (const place of ["cloud", "mac"] as const) {
    for (const [engine, provider] of cases) {
      const title = noConnectionNote(engine, provider, place).title;
      // As an engine's CLI reports it: its own prefix, then the request's error.
      const error = `API Error: 401 ${noConnectionMessage(engine, provider, place)}`;
      expect(
        failedWhy({ status: "failed", error }),
        `${engine} ${provider ?? "no provider"} ${place}`,
      ).toBe(title);
    }
  }
  expect(noConnectionNote("claude-agent").title).toBe("Claude isn't connected for Cloud.");
});

test("any other failure gets one sentence of ours by its class, and a stop says it was stopped", () => {
  expect(failedWhy({ status: "interrupted" })).toBe("It was stopped.");
  expect(
    failedWhy({ status: "failed", error: "ECONNRESET", failure: { class: "transport_error" } }),
  ).toBe("It lost touch with its agent.");
  expect(failedWhy({ status: "failed", error: "exit 1" })).toBe("Its agent stopped with an error.");
});
