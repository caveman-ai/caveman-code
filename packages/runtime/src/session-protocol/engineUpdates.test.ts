import type { ServerProvider } from "@caveman-app/protocol";
import { describe, expect, test } from "vitest";

import { BUNDLED_CLAUDE_MODEL_CATALOG, resolveClaudeModelsForVersion, resolveClaudeUpdateRequiredModels } from "../provider/ClaudeModelCatalog.ts";
import { autoUpdateKey, engineUpgrade, modelsNeedingUpdate, withModelsNeedingUpdate } from "./engineUpdates.ts";

/** A Claude Agent snapshot as ClaudeProvider builds it for an installed `claude --version`. */
const claude = (version: string, over: Partial<ServerProvider> = {}): ServerProvider =>
  ({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    version,
    models: resolveClaudeModelsForVersion(BUNDLED_CLAUDE_MODEL_CATALOG, version),
    updateRequiredModels: resolveClaudeUpdateRequiredModels(BUNDLED_CLAUDE_MODEL_CATALOG, version),
    ...over,
  }) as unknown as ServerProvider;

describe("a Claude Code too old for Opus 5.5 (the bundled manifest)", () => {
  test("the installed CLI runs up to Opus 5, and Opus 5.5 is listed as needing 2.1.280", () => {
    // A Claude Code from before 2026-09-22: what a friend's laptop showed, "up to Opus 5".
    const old = claude("2.1.270");
    expect(old.models.map((m) => m.slug)).toContain("claude-opus-5");
    expect(old.models.map((m) => m.slug)).not.toContain("claude-opus-5-5");
    const listed = modelsNeedingUpdate(old);
    expect(listed.find((m) => m.id === "claude-opus-5-5")).toMatchObject({ label: "Claude Opus 5.5", needs_version: "2.1.280" });
    expect(listed.find((m) => m.id === "claude-opus-5-5")?.description).toBe("Needs Claude Code 2.1.280 or newer (this computer has 2.1.270). Run claude update.");
    // Sonnet 5.5 (2.1.284), Fable 5.2 (2.1.321) and Haiku 5.5 (2.1.293) too: Settings names the newest version any
    // of them needs.
    expect(engineUpgrade(old)).toEqual({ version: "2.1.321", hint: "Claude Opus 5.5, Claude Sonnet 5.5, Claude Fable 5.2, Claude Haiku 5.5 need Claude Code 2.1.321 or newer. Run claude update." });
  });

  test("the picker lists each in its place, above the newest model of its family the CLI runs", () => {
    const old = claude("2.1.270");
    const listed = old.models.map((m) => ({ id: m.slug, label: m.name }));
    const ids = withModelsNeedingUpdate(listed, old).map((m) => m.id);
    // Opus 5.5 above Opus 5, not under Opus 4.5; Sonnet 5.5 above Sonnet 5; Fable 5.2 above Fable 5.1; Haiku 5.5
    // above Haiku 4.5.
    expect(ids.indexOf("claude-opus-5-5")).toBe(ids.indexOf("claude-opus-5") - 1);
    expect(ids.indexOf("claude-sonnet-5-5")).toBe(ids.indexOf("claude-sonnet-5") - 1);
    expect(ids.indexOf("claude-fable-5-2")).toBe(ids.indexOf("claude-fable-5-1") - 1);
    expect(ids.indexOf("claude-haiku-5-5")).toBe(ids.indexOf("claude-haiku-4-5") - 1);
    expect(ids.length).toBe(listed.length + 4);
    // Two of one family keep the catalog's order (newest first); one whose family the CLI runs none of goes first.
    const two = claude("2.1.270", { updateRequiredModels: [{ slug: "claude-opus-6", name: "Claude Opus 6", minVersion: "2.2.0" }, { slug: "claude-opus-5-5", name: "Claude Opus 5.5", minVersion: "2.1.280" }, { slug: "claude-lyra-1", name: "Claude Lyra 1", minVersion: "2.2.0" }] });
    const placed = withModelsNeedingUpdate(listed, two).map((m) => m.id);
    expect(placed[0]).toBe("claude-lyra-1");
    expect(placed.slice(placed.indexOf("claude-opus-6"), placed.indexOf("claude-opus-6") + 3)).toEqual(["claude-opus-6", "claude-opus-5-5", "claude-opus-5"]);
  });

  test("a current Claude Code runs Opus 5.5 itself, and nothing needs an update", () => {
    const current = claude("2.1.321");
    expect(current.models.map((m) => m.slug)).toContain("claude-opus-5-5");
    expect(modelsNeedingUpdate(current)).toEqual([]);
    expect(engineUpgrade(current)).toBeUndefined();
    expect(autoUpdateKey(current, { env: {}, updateChecks: true, cloudComputer: false })).toBeUndefined();
  });

  test("says when the update runs, and why it failed", () => {
    const running = claude("2.1.270", { updateState: { status: "running", startedAt: null, finishedAt: null, message: "Running claude update", output: null } });
    expect(modelsNeedingUpdate(running)[0]?.description).toBe("Needs Claude Code 2.1.280. Caveman Code is updating it now.");
    expect(engineUpgrade(running)?.hint).toMatch(/^Updating Claude Code for Claude Opus 5\.5/);
    const failed = claude("2.1.270", { updateState: { status: "failed", startedAt: null, finishedAt: null, message: "EACCES: permission denied", output: null } });
    expect(engineUpgrade(failed)?.hint).toMatch(/Run claude update\. The update failed: EACCES: permission denied$/);
  });

  test("updates Claude Code once per installed version, unless the person or the computer keeps it", () => {
    const old = claude("2.1.270");
    expect(autoUpdateKey(old, { env: {}, updateChecks: true, cloudComputer: false })).toBe("claudeAgent@2.1.270");
    // Claude Code's own opt-out, Settings' provider update checks, a Cloud computer's image.
    expect(autoUpdateKey(old, { env: { DISABLE_AUTOUPDATER: "1" }, updateChecks: true, cloudComputer: false })).toBeUndefined();
    expect(autoUpdateKey(old, { env: {}, updateChecks: false, cloudComputer: false })).toBeUndefined();
    expect(autoUpdateKey(old, { env: {}, updateChecks: true, cloudComputer: true })).toBeUndefined();
    // Nothing to update: not installed, or one already running.
    expect(autoUpdateKey(claude("2.1.270", { installed: false }), { env: {}, updateChecks: true, cloudComputer: false })).toBeUndefined();
    expect(autoUpdateKey(claude("2.1.270", { updateState: { status: "queued", startedAt: null, finishedAt: null, message: null, output: null } }), { env: {}, updateChecks: true, cloudComputer: false })).toBeUndefined();
    // The Codex CLI only asks to be updated: listed, never updated here.
    expect(autoUpdateKey(claude("2.1.270", { driver: "codex" } as Partial<ServerProvider>), { env: {}, updateChecks: true, cloudComputer: false })).toBeUndefined();
  });
});
