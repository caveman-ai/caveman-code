/** What levers.ts says the harness does, read back from the vendored harness's app loadouts. */
import { assert, describe, it } from "@effect/vitest";
import { appLoadoutFor, appLoadouts, type Loadout } from "@caveman-ai/harness";

import { HARNESS_LEVERS } from "./levers.ts";

interface Shape {
  readonly limits: {
    readonly output_cap_bytes: number;
    readonly output_cap_lines: number;
    readonly spill: boolean;
  };
  readonly policy: {
    readonly loop: { readonly stop_at: number };
    readonly empty_turns_stop: number;
    readonly retry: { readonly attempts: number };
  };
  readonly wire: {
    readonly max_retries: number;
    readonly anthropic?: { readonly keepalive_s?: number };
  };
}
const shape = (loadout: Loadout) => loadout as unknown as Loadout & Shape;

describe("the harness's levers", () => {
  const { claude, gpt, general } = appLoadouts();
  const all = [claude, gpt, general].map(shape);

  it("are each one plain line, as explain shows them", () => {
    for (const [id, label] of Object.entries(HARNESS_LEVERS))
      assert.match(label, /^[A-Z][^\n]+[^.]$/, id);
  });

  it("put each model on its own surface: Codex's for GPT on a Responses API, Claude Code's for the rest", () => {
    assert.strictEqual(
      appLoadoutFor({ api: "openai-responses", id: "gpt-6.1-sol" }).surface,
      "exec",
    );
    assert.strictEqual(
      appLoadoutFor({ api: "anthropic-messages", id: "claude-opus-5-5" }).name,
      claude.name,
    );
    assert.strictEqual(
      appLoadoutFor({ api: "google-generative-ai", id: "gemini-3.1-pro-preview" }).surface,
      "compact",
    );
  });

  it("reach MCP from programs in a coding session", () => {
    assert.strictEqual(claude.mcp?.exposure, "program");
    assert.strictEqual(gpt.mcp?.exposure, "program");
  });

  it("cap long output at 50 KB or 2,000 lines and keep the whole of it in a file", () => {
    for (const loadout of all)
      assert.deepStrictEqual(
        loadout.limits,
        { output_cap_bytes: 51_200, output_cap_lines: 2_000, spill: true },
        loadout.name,
      );
  });

  it("stop a loop of the same call and a run of empty answers, and retry an outage", () => {
    for (const loadout of all) {
      assert.isAbove(loadout.policy.loop.stop_at, 0, loadout.name);
      assert.isAbove(loadout.policy.empty_turns_stop, 0, loadout.name);
      assert.isAbove(loadout.policy.retry.attempts, 0, loadout.name);
      assert.isAbove(loadout.wire.max_retries, 0, loadout.name);
    }
  });

  it("keep Claude's cache warm wherever a Claude model can run", () => {
    assert.isAbove(shape(claude).wire.anthropic?.keepalive_s ?? 0, 0);
    assert.isAbove(shape(general).wire.anthropic?.keepalive_s ?? 0, 0);
  });
});
