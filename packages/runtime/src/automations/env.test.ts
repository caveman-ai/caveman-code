import { describe, expect, it } from "vitest";

import { HARNESS_LEVERS } from "@caveman-app/provider-caveman/levers";

import { envSnapshot, LEVER_EVIDENCE, offlineEnv } from "./env.ts";

const provider = (over: Record<string, unknown>) =>
  ({
    instanceId: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated", type: "apiKey" },
    models: [{ slug: "claude-opus-5-5" }, { slug: "claude-sonnet-5-5" }, { slug: "claude-haiku-5-5" }],
    ...over,
  }) as never;

describe("the environment explain and check see", () => {
  it("resolves each engine's classes from its own model, and says why an engine cannot run", () => {
    const env = envSnapshot({
      defaultEngine: "claude-agent",
      engines: [
        { id: "claude-agent", provider: provider({ auth: { status: "authenticated", type: "claudeAi" } }), defaultModel: "claude-opus-5-5" },
        { id: "codex", provider: provider({ instanceId: "codex", installed: false, models: [{ slug: "gpt-6-luna" }] }) },
        { id: "caveman" },
      ],
    });
    expect(env.classes["claude-agent"]).toEqual({ fast: "claude-haiku-5-5", base: "claude-sonnet-5-5", frontier: "claude-opus-5-5", source: "Claude class table" });
    expect(env.engines).toEqual([
      { id: "claude-agent", available: true, subscription: true },
      { id: "codex", available: false, reason: "it is not installed" },
      { id: "caveman", available: false, reason: "it is not set up in Caveman Code" },
    ]);
    expect(env.servedTriggers).toEqual(["manual", "schedule", "github"]);
  });

  it("reads the class table beside a listed model when the default is Auto", () => {
    const env = envSnapshot({ defaultEngine: "caveman", engines: [{ id: "caveman", provider: provider({ instanceId: "caveman" }), defaultModel: "auto" }] });
    expect(env.classes.caveman?.base).toBe("claude-sonnet-5-5");
  });

  it("sums the Caveman harness up in one measured row, then lists what it does, and says other engines get none of it", () => {
    const env = envSnapshot({ defaultEngine: "codex", engines: [{ id: "codex", provider: provider({ instanceId: "codex" }) }] });
    const caveman = env.levers.filter((l) => l.engine === "caveman");
    expect(caveman[0]).toEqual({ engine: "caveman", id: "all", label: "Caveman harness", on: true, evidence: LEVER_EVIDENCE });
    // Measured against the classic engine it replaced, in the app's own runner.
    expect(LEVER_EVIDENCE).toMatch(/classic engine.*0\.47x.*48\/48.*44\/48/);
    // Everything provider-caveman says the harness does, in its words, each always on.
    expect(caveman.slice(1).map((l) => [l.id, l.label])).toEqual(Object.entries(HARNESS_LEVERS));
    for (const l of caveman) expect(l.label, l.id).toMatch(/^[A-Z]/);
    expect(caveman.every((l) => l.on)).toBe(true);
    expect(env.levers.find((l) => l.engine === "codex")).toMatchObject({ on: false, evidence: "they run on the caveman engine only" });
  });

  it("names nothing of the classic engine: no compression, Keep, sidekick or engine binary", () => {
    const env = envSnapshot({ defaultEngine: "caveman", engines: [] });
    expect(env.levers.filter((l) => !l.on)).toEqual([]);
    expect(env.levers.some((l) => ["compression", "keep", "fusion", "logDigest"].includes(l.id))).toBe(false);
    expect(JSON.stringify(env.levers)).not.toMatch(/sidekick|compress|caveman-engine/i);
    expect(env.levers[0]!.evidence).toBe(LEVER_EVIDENCE);
  });

  it("offline, knows no engines and keeps the trigger home", () => {
    expect(offlineEnv("github-actions")).toMatchObject({ host: "this-mac", engines: [], classes: {}, triggerHome: "github-actions", offline: true });
  });
});
