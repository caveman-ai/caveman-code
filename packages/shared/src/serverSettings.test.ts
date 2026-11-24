// ), packages/shared/src/serverSettings.test.ts @ ab3a3cd1.
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
  type ServerProvider,
} from "@caveman-app/protocol";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { resolveServerBackgroundActivitySettings } from "./backgroundActivitySettings.ts";
import { createModelSelection } from "./model.ts";
import { resolveProjectScripts, projectScriptsInheritDefaults } from "./projectScripts.ts";
import {
  applyServerSettingsPatch,
  automaticReviewGuideWriters,
  fallbackTextGenerationModelSelection,
  modelPreferencesMigrationPatch,
  resolveModelPreferences,
  isModelSelectionProviderEnabled,
  parsePersistedServerObservabilitySettings,
  rankReviewGuideWriters,
  textGenerationWriters,
  resolveReviewGuideModelSelection,
  resolveSourceControlWriterModelSelection,
  reviewGuideWriterRank,
  reviewGuideWriters,
  resolveProjectAgentBrowserAccess,
  resolveProjectAutoPull,
} from "./serverSettings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

/** Settings after the server has folded legacy per-project fields into `projectSettingsOverrides`. */
const FOLDED_SERVER_SETTINGS = { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true };

describe("fallbackTextGenerationModelSelection", () => {
  it("uses Big Pickle when only OpenCode is enabled", () => {
    expect(
      fallbackTextGenerationModelSelection({}, (instanceId) => instanceId === "opencode"),
    ).toEqual({ instanceId: "opencode", model: "opencode/big-pickle" });
  });

  it("ignores a configured non-default instance at machine scope, matching no fallback", () => {
    const configured = ProviderInstanceId.make("codex_work");
    const providerInstances = {
      [configured]: { driver: ProviderDriverKind.make("codex"), config: {} },
    };
    const fallback = fallbackTextGenerationModelSelection(providerInstances, (instanceId) =>
      instanceId === configured,
    );
    expect(fallback).toBeNull();
  });

  it("considers a configured non-default instance only when asked to", () => {
    const configured = ProviderInstanceId.make("codex_work");
    const providerInstances = {
      [configured]: { driver: ProviderDriverKind.make("codex"), config: {} },
    };
    const fallback = fallbackTextGenerationModelSelection(
      providerInstances,
      (instanceId) => instanceId === configured,
      { includeConfiguredInstances: true },
    );
    expect(fallback?.instanceId).toBe(configured);
  });
});

describe("rankReviewGuideWriters", () => {
  const provider = (
    driver: string,
    auth: ServerProvider["auth"],
    options: {
      instanceId?: string;
      models?: ReadonlyArray<string | { slug: string; subProvider: string }>;
      usedPercent?: number;
    } = {},
  ): ServerProvider => ({
    instanceId: ProviderInstanceId.make(options.instanceId ?? driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth,
    checkedAt: "2026-10-19T00:00:00.000Z",
    models: (options.models ?? []).map((model) => {
      const { slug, subProvider } = typeof model === "string" ? { slug: model, subProvider: undefined } : model;
      return { slug, name: slug, isCustom: false, capabilities: null, ...(subProvider ? { subProvider } : {}) };
    }),
    slashCommands: [],
    skills: [],
    ...(options.usedPercent === undefined
      ? {}
      : {
          usageLimits: {
            checkedAt: "2026-10-19T00:00:00.000Z",
            windows: [{ id: "5h", kind: "session" as const, label: "5h", usedPercent: options.usedPercent }],
          },
        }),
  });
  const claudeMax = provider("claudeAgent", { status: "authenticated", type: "max", label: "Claude Max Subscription" }, {
    models: ["claude-fable-5-1", "claude-haiku-5-5", "claude-sonnet-5-5"],
  });
  const codexApiKey = provider("codex", { status: "authenticated", type: "apiKey", label: "OpenAI API Key" });
  const cursorLogin = provider("cursor", { status: "authenticated", type: "browser", label: "Cursor account" }, {
    models: ["auto", "composer-2"],
  });
  const grokLogin = provider("grok", { status: "authenticated", type: "cached_token", label: "Grok account" });
  const opencode = provider("opencode", { status: "authenticated" });
  const caveman = (models: ReadonlyArray<{ slug: string; subProvider: string }>) =>
    provider("caveman", { status: "authenticated", type: "api_key" }, { models });
  const signedOut = provider("muse", { status: "unauthenticated" });
  // Cursor, Grok, OpenCode and the Caveman engine are off until the person turns them on.
  const enabled = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: Object.fromEntries(
      ["cursor", "grok", "opencode", "caveman", "muse", "pi", "antigravity"].map((driver) => [
        ProviderInstanceId.make(driver),
        { driver: ProviderDriverKind.make(driver), enabled: true, config: {} },
      ]),
    ),
  };

  it("writes on each harness's cheapest guide model, a subscription before a key, and skips a harness with none", () => {
    const ranked = rankReviewGuideWriters(
      enabled,
      [
        caveman([{ slug: "openai/gpt-6-luna", subProvider: "openai" }]),
        codexApiKey,
        opencode,
        grokLogin,
        cursorLogin,
        claudeMax,
        signedOut,
      ],
      null,
    );
    // Grok has listed no model yet and OpenCode only a full-size one: neither writes.
    expect(ranked).toEqual([
      { instanceId: "claudeAgent", model: "claude-haiku-5-5", options: [{ id: "effort", value: "low" }] },
      { instanceId: "cursor", model: "composer-2" },
      { instanceId: "codex", model: "gpt-6-luna" },
      { instanceId: "caveman", model: "openai/gpt-6-luna" },
    ]);
  });

  it("takes the cheapest model on Caveman credits first, as a subscription, and the person's own keys after", () => {
    const both = caveman([
      { slug: "caveman/anthropic/claude-haiku-5-5", subProvider: "caveman" },
      { slug: "caveman/deepseek/deepseek-flash", subProvider: "caveman" },
      { slug: "anthropic/claude-opus-5-5", subProvider: "anthropic" },
      { slug: "deepseek/deepseek-flash", subProvider: "deepseek" },
    ]);
    expect(reviewGuideWriterRank(both, "caveman/deepseek/deepseek-flash")).toBe(0);
    expect(reviewGuideWriterRank(both, "deepseek/deepseek-flash")).toBe(2);
    // Haiku lists at $0.10 / $0.50, DeepSeek Flash at $0.30 / $1.20: on credits Haiku is cheaper. At the same price
    // a Claude login goes before credits, which draw down the plan. A key that only has DeepSeek Flash still gets it.
    expect(rankReviewGuideWriters(enabled, [claudeMax, both], null)).toEqual([
      { instanceId: "claudeAgent", model: "claude-haiku-5-5", options: [{ id: "effort", value: "low" }] },
      { instanceId: "caveman", model: "caveman/anthropic/claude-haiku-5-5" },
      { instanceId: "caveman", model: "deepseek/deepseek-flash" },
    ]);
    expect(
      rankReviewGuideWriters(enabled, [caveman([{ slug: "caveman/deepseek/deepseek-flash", subProvider: "caveman" }])], null),
    ).toEqual([{ instanceId: "caveman", model: "caveman/deepseek/deepseek-flash" }]);
  });

  it("takes the cheapest of the person's own keys, and never a frontier model", () => {
    const byok = caveman([
      { slug: "openai/gpt-6.1-sol", subProvider: "openai" },
      { slug: "anthropic/claude-haiku-5-5", subProvider: "anthropic" },
      { slug: "openai/gpt-6-luna", subProvider: "openai" },
    ]);
    expect(rankReviewGuideWriters(enabled, [byok], null)).toEqual([
      { instanceId: "caveman", model: "anthropic/claude-haiku-5-5" },
    ]);
    const frontierOnly = caveman([{ slug: "anthropic/claude-opus-5-5", subProvider: "anthropic" }]);
    expect(rankReviewGuideWriters(enabled, [frontierOnly], null)).toEqual([]);
    // Nobody asked: no writer. A person asking still gets the source control writer.
    expect(automaticReviewGuideWriters(enabled, [frontierOnly], null)).toEqual([]);
    expect(reviewGuideWriters(enabled, [frontierOnly], null)).toEqual([
      resolveSourceControlWriterModelSelection(enabled, [frontierOnly], null),
    ]);
  });

  it("finds a guide model on every harness, never a frontier, lite or nano one", () => {
    const login = { status: "authenticated" as const, type: "browser" };
    const pick = (driver: string, models: ReadonlyArray<string>) =>
      rankReviewGuideWriters(enabled, [provider(driver, login, { models })], null)[0]?.model;
    expect(pick("cursor", ["auto", "composer-2", "gpt-5.6-luna", "claude-haiku-5-5", "glm-5p3-flash", "gemini-3.8-flash"])).toBe(
      "claude-haiku-5-5",
    );
    expect(pick("cursor", ["auto", "composer-2.5", "claude-opus-5-5"])).toBe("composer-2.5");
    expect(pick("antigravity", ["gemini-3.1-pro-low", "gemini-3.8-flash-high", "gemini-3.8-flash-low"])).toBe("gemini-3.8-flash-low");
    expect(pick("grok", ["grok-4.6", "grok-composer-2.5-fast"])).toBe("grok-composer-2.5-fast");
    expect(pick("muse", ["muse-wonder-1.0", "muse-spark-1.3"])).toBe("muse-spark-1.3");
    expect(pick("opencode", ["openai/gpt-5", "openrouter/deepseek/deepseek-v4-flash", "zai/glm-5.3-flash"])).toBe("zai/glm-5.3-flash");
    expect(pick("pi", ["default", "google/gemini-2.5-flash-lite", "deepseek/deepseek-flash"])).toBe("deepseek/deepseek-flash");
    expect(pick("grok", ["grok-4.7", "grok-build"])).toBeUndefined();
    expect(pick("antigravity", ["gemini-3.1-pro-low", "gemini-3.1-flash-lite"])).toBeUndefined();
  });

  it("prefers the plan with more room left among equally cheap models", () => {
    const busyClaude = provider("claudeAgent", { status: "authenticated", type: "max" }, { usedPercent: 90 });
    const idleCursor = provider("cursor", { status: "authenticated", type: "browser" }, {
      models: ["claude-haiku-5-5"],
      usedPercent: 10,
    });
    expect(
      rankReviewGuideWriters(enabled, [busyClaude, idleCursor], null).map(
        (selection) => selection.instanceId,
      ),
    ).toEqual(["cursor", "claudeAgent"]);
  });

  it("ranks a ChatGPT login above Claude on an API key", () => {
    const claudeKey = provider("claudeAgent", { status: "authenticated", type: "apiKey" });
    const codexPlan = provider("codex", { status: "authenticated", type: "chatgpt" });
    expect(reviewGuideWriterRank(codexPlan)).toBe(0);
    expect(reviewGuideWriterRank(claudeKey)).toBe(2);
    expect(
      rankReviewGuideWriters(DEFAULT_SERVER_SETTINGS, [claudeKey, codexPlan], null).map(
        (selection) => selection.instanceId,
      ),
    ).toEqual(["codex", "claudeAgent"]);
  });
});

describe("resolveReviewGuideModelSelection", () => {
  const snapshot = (driver: string, installed: boolean): ServerProvider => ({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed,
    version: installed ? "1.0.0" : null,
    status: installed ? "ready" : "error",
    auth: { status: installed ? "authenticated" : "unknown" },
    checkedAt: "2026-10-19T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  });

  it("uses Codex's cheap text model where Codex runs", () => {
    const selection = resolveReviewGuideModelSelection(
      DEFAULT_SERVER_SETTINGS,
      [snapshot("codex", true), snapshot("claudeAgent", true)],
      null,
    );
    expect(selection).toEqual({ instanceId: "codex", model: "gpt-6-luna" });
  });

  it("keeps the guide model set in Settings as the only writer", () => {
    const chosen = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-sonnet-5-5" };
    expect(
      reviewGuideWriters(
        { ...DEFAULT_SERVER_SETTINGS, reviewGuideModelSelection: chosen },
        [snapshot("codex", true), snapshot("claudeAgent", true)],
        null,
      ),
    ).toEqual([chosen]);
  });

  it("falls to Claude Agent's Haiku on a Mac without Codex", () => {
    const selection = resolveReviewGuideModelSelection(
      DEFAULT_SERVER_SETTINGS,
      [snapshot("codex", false), snapshot("claudeAgent", true)],
      null,
    );
    expect(selection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-haiku-5-5",
      options: [{ id: "effort", value: "low" }],
    });
  });

  it("keeps the configured writer when nothing here can run", () => {
    expect(
      resolveReviewGuideModelSelection(DEFAULT_SERVER_SETTINGS, [snapshot("codex", false)], null),
    ).toBe(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection);
  });
});

describe("serverSettings helpers", () => {
  it("changes a cleanup rule without replacing the machine's other rules", () => {
    const enabled = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      storageCleanup: { worktreeAfterDays: 8, worktreeOnMerge: true, logsAfterDays: 30 },
    });
    expect(
      applyServerSettingsPatch(enabled, {
        storageCleanup: { worktreeAfterDays: null },
      }).storageCleanup,
    ).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: true,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
      browserArtifactsAfterDays: null,
      logsAfterDays: 30,
    });
  });
  it("replaces a source control host's patched field so a cleared account pin does not survive", () => {
    const pinned = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      sourceControlHosts: {
        github: { hosts: { "github.com": { account: "work", enabled: true } }, tokens: {} },
      },
    });
    const unpinned = applyServerSettingsPatch(pinned, {
      sourceControlHosts: { github: { hosts: { "github.com": { enabled: false } } } },
    });
    expect(unpinned.sourceControlHosts.github).toEqual({
      hosts: { "github.com": { enabled: false } },
      tokens: {},
    });
  });
  it("inherits actions, preserves existing actions, and supports empty overrides and reset", () => {
    const project = { id: ProjectId.make("project-actions"), scripts: [] };
    const action = {
      id: "check",
      name: "Check",
      command: "npm test",
      icon: "play" as const,
      runOnWorktreeCreate: false,
    };
    const existing = { ...project, scripts: [{ ...action, command: "npm run lint" }] };
    // Before the one-time fold, scripts stored on the project aggregate still apply.
    const unfolded = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultProjectScripts: [action],
    });
    expect(resolveProjectScripts(unfolded, existing)).toEqual(existing.scripts);
    expect(projectScriptsInheritDefaults(unfolded, existing)).toBe(false);
    const defaults = applyServerSettingsPatch(FOLDED_SERVER_SETTINGS, {
      defaultProjectScripts: [action],
    });
    expect(resolveProjectScripts(defaults, project)).toEqual([action]);
    expect(projectScriptsInheritDefaults(defaults, project)).toBe(true);
    expect(resolveProjectScripts(defaults, existing)).toEqual([action]);
    const disabled = applyServerSettingsPatch(defaults, {
      projectScriptOverrides: { [project.id]: [] },
    });
    expect(resolveProjectScripts(disabled, project)).toEqual([]);
    expect(projectScriptsInheritDefaults(disabled, project)).toBe(false);
    const changedDefault = applyServerSettingsPatch(disabled, {
      defaultProjectScripts: [{ ...action, command: "npm run build" }],
    });
    expect(resolveProjectScripts(changedDefault, project)).toEqual([]);
    const reset = applyServerSettingsPatch(changedDefault, {
      projectScriptOverrides: { [project.id]: null },
    });
    expect(resolveProjectScripts(reset, existing)).toEqual(changedDefault.defaultProjectScripts);
    expect(projectScriptsInheritDefaults(reset, existing)).toBe(true);
    expect(
      resolveProjectScripts(
        applyServerSettingsPatch(reset, { defaultProjectScripts: [] }),
        existing,
      ),
    ).toEqual([]);
  });

  it("preserves other projects' actions when overriding, clearing, or resetting one project", () => {
    const firstProject = { id: ProjectId.make("first-project"), scripts: [] };
    const secondProject = { id: ProjectId.make("second-project"), scripts: [] };
    const defaultAction = {
      id: "check",
      name: "Check",
      command: "npm test",
      icon: "play" as const,
      runOnWorktreeCreate: false,
    };
    const firstAction = { ...defaultAction, command: "npm run lint" };
    const secondAction = { ...defaultAction, command: "npm run build" };
    const firstUpdate = applyServerSettingsPatch(FOLDED_SERVER_SETTINGS, {
      defaultProjectScripts: [defaultAction],
      projectScriptOverrides: { [firstProject.id]: [firstAction] },
    });
    const secondUpdate = applyServerSettingsPatch(firstUpdate, {
      projectScriptOverrides: { [secondProject.id]: [secondAction] },
    });
    expect(resolveProjectScripts(secondUpdate, firstProject)).toEqual([firstAction]);
    expect(resolveProjectScripts(secondUpdate, secondProject)).toEqual([secondAction]);

    const cleared = applyServerSettingsPatch(secondUpdate, {
      projectScriptOverrides: { [firstProject.id]: [] },
    });
    expect(resolveProjectScripts(cleared, firstProject)).toEqual([]);
    expect(resolveProjectScripts(cleared, secondProject)).toEqual([secondAction]);

    const reset = applyServerSettingsPatch(cleared, {
      projectScriptOverrides: { [firstProject.id]: null },
    });
    expect(resolveProjectScripts(reset, { ...firstProject, scripts: [firstAction] })).toEqual([
      defaultAction,
    ]);
    expect(resolveProjectScripts(reset, secondProject)).toEqual([secondAction]);
    expect(resolveProjectScripts(secondUpdate, firstProject)).toEqual([firstAction]);
  });

  it("inherits automatic pull while preserving legacy opt-ins and explicit overrides", () => {
    const projectId = ProjectId.make("project-pull");
    expect(resolveProjectAutoPull(DEFAULT_SERVER_SETTINGS, projectId, false)).toBe(false);
    expect(resolveProjectAutoPull(DEFAULT_SERVER_SETTINGS, projectId, true)).toBe(true);
    const enabled = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { defaultAutoPull: true });
    expect(resolveProjectAutoPull(enabled, projectId, false)).toBe(true);
    const overridden = applyServerSettingsPatch(enabled, {
      projectAutoPullOverrides: { [projectId]: false },
    });
    expect(resolveProjectAutoPull(overridden, projectId, true)).toBe(false);
    const reset = applyServerSettingsPatch(overridden, {
      projectAutoPullOverrides: { [projectId]: null },
    });
    expect(resolveProjectAutoPull(reset, projectId, false)).toBe(true);
    const disabled = applyServerSettingsPatch(reset, {
      defaultAutoPull: false,
      projectAutoPullOverrides: { [projectId]: true },
    });
    expect(resolveProjectAutoPull(disabled, projectId, false)).toBe(true);
    expect(resolveProjectAutoPull(disabled, ProjectId.make("other-project"), false)).toBe(false);
  });

  it("inherits browser access and restores inheritance when a project override is removed", () => {
    const projectId = ProjectId.make("project-browser");
    const otherProjectId = ProjectId.make("other-project");
    const overridden = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectAgentBrowserAccessOverrides: { [projectId]: false },
    });
    expect(resolveProjectAgentBrowserAccess(overridden, projectId)).toBe(false);
    expect(resolveProjectAgentBrowserAccess(overridden, otherProjectId)).toBe(true);
    const reset = applyServerSettingsPatch(overridden, {
      projectAgentBrowserAccessOverrides: { [projectId]: null },
    });
    expect(resolveProjectAgentBrowserAccess(reset, projectId)).toBe(true);
    const enabled = applyServerSettingsPatch(reset, {
      enableAgentBrowserAccess: false,
      projectAgentBrowserAccessOverrides: { [projectId]: true },
    });
    expect(resolveProjectAgentBrowserAccess(enabled, projectId)).toBe(true);
    expect(resolveProjectAgentBrowserAccess(enabled, otherProjectId)).toBe(false);
  });

  it("preserves other projects' boolean overrides across separate updates and resets", () => {
    const firstProjectId = ProjectId.make("first-project");
    const secondProjectId = ProjectId.make("second-project");
    const firstUpdate = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultAutoPull: true,
      projectAutoPullOverrides: { [firstProjectId]: false },
      projectAgentBrowserAccessOverrides: { [firstProjectId]: false },
    });
    const secondUpdate = applyServerSettingsPatch(firstUpdate, {
      projectAutoPullOverrides: { [secondProjectId]: false },
      projectAgentBrowserAccessOverrides: { [secondProjectId]: false },
    });
    for (const projectId of [firstProjectId, secondProjectId]) {
      expect(resolveProjectAutoPull(secondUpdate, projectId, false)).toBe(false);
      expect(resolveProjectAgentBrowserAccess(secondUpdate, projectId)).toBe(false);
    }

    const reset = applyServerSettingsPatch(secondUpdate, {
      projectAutoPullOverrides: { [firstProjectId]: null },
      projectAgentBrowserAccessOverrides: { [firstProjectId]: null },
    });
    expect(resolveProjectAutoPull(reset, firstProjectId, false)).toBe(true);
    expect(resolveProjectAgentBrowserAccess(reset, firstProjectId)).toBe(true);
    expect(resolveProjectAutoPull(reset, secondProjectId, false)).toBe(false);
    expect(resolveProjectAgentBrowserAccess(reset, secondProjectId)).toBe(false);
    expect(reset.projectAutoPullOverrides[firstProjectId]).toBeUndefined();
    expect(reset.projectAgentBrowserAccessOverrides[firstProjectId]).toBeUndefined();
    expect(resolveProjectAutoPull(secondUpdate, firstProjectId, false)).toBe(false);
    expect(resolveProjectAgentBrowserAccess(secondUpdate, firstProjectId)).toBe(false);
  });

  it("replaces and clears conversation model defaults without retaining old options", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultModelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
      ]),
    });
    const selection = createModelSelection(ProviderInstanceId.make("claudeAgent"), "sonnet");
    const updated = applyServerSettingsPatch(current, { defaultModelSelection: selection });
    expect(updated.defaultModelSelection).toEqual(selection);
    expect(
      applyServerSettingsPatch(updated, { defaultModelSelection: null }).defaultModelSelection,
    ).toBeNull();
  });

  it("ignores missing and blank persisted observability URLs", () => {
    expect(parsePersistedServerObservabilitySettings("{}")).toEqual({
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
    });
    expect(
      parsePersistedServerObservabilitySettings(
        JSON.stringify({
          observability: { otlpTracesUrl: "   ", otlpMetricsUrl: "", otlpLogsUrl: "   " },
        }),
      ),
    ).toEqual({
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
    });
  });

  it("parses lenient persisted settings JSON and trims observability URLs", () => {
    expect(
      parsePersistedServerObservabilitySettings(
        JSON.stringify({
          observability: {
            otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
            otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
            otlpLogsUrl: "  http://localhost:4318/v1/logs  ",
          },
        }),
      ),
    ).toEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      otlpLogsUrl: "http://localhost:4318/v1/logs",
    });
    // The server still loads a file holding the retired token streaming mode.
    expect(
      parsePersistedServerObservabilitySettings(
        JSON.stringify({
          responseStreamingMode: "token",
          observability: { otlpTracesUrl: "http://localhost:4318/v1/traces" },
        }),
      ).otlpTracesUrl,
    ).toBe("http://localhost:4318/v1/traces");
  });

  it("falls back cleanly when persisted settings are invalid", () => {
    expect(parsePersistedServerObservabilitySettings("{")).toEqual({
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
    });
  });

  it("replaces text generation selection when provider/model are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("still deep merges text generation selection when only options are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: false },
      ],
    });
  });

  it("replaces text generation selection across providers without leaking stale options", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
    });
  });

  it("accepts array-based text generation selection patches", () => {
    expect(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
          options: [
            { id: "variant", value: "prod" },
            { id: "agent", value: "build" },
          ],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
      options: [
        { id: "variant", value: "prod" },
        { id: "agent", value: "build" },
      ],
    });
  });

  it("replaces source control writer selection without retaining stale options", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      sourceControlWriterModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [{ id: "reasoningEffort", value: "high" }],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        sourceControlWriterModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      }).sourceControlWriterModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
    });
  });

  it("clears source control writer selection with null", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      sourceControlWriterModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        sourceControlWriterModelSelection: null,
      }).sourceControlWriterModelSelection,
    ).toBeNull();
  });

  it("falls back from a disabled source control writer provider without clearing its selection", () => {
    const instanceId = ProviderInstanceId.make("codex_writer");
    const sourceControlWriterModelSelection = createModelSelection(instanceId, "gpt-5.4-mini");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          config: {},
        },
      },
      sourceControlWriterModelSelection,
    };

    expect(isModelSelectionProviderEnabled(settings, sourceControlWriterModelSelection)).toBe(
      false,
    );
    expect(resolveSourceControlWriterModelSelection(settings, undefined, null)).toBe(
      settings.textGenerationModelSelection,
    );
    expect(settings.sourceControlWriterModelSelection).toBe(sourceControlWriterModelSelection);
  });

  it("falls back from an unavailable source control writer provider", () => {
    const instanceId = ProviderInstanceId.make("missing_writer");
    const sourceControlWriterModelSelection = createModelSelection(instanceId, "missing-model");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("missing-driver"),
          config: {},
        },
      },
      sourceControlWriterModelSelection,
    };
    const unavailableProvider = {
      instanceId,
      driver: ProviderDriverKind.make("missing-driver"),
      enabled: false,
      installed: false,
      version: null,
      status: "disabled",
      auth: { status: "unknown" },
      checkedAt: "2026-07-27T00:00:00.000Z",
      availability: "unavailable",
      unavailableReason: "This provider driver is not available in this build.",
      models: [],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;

    expect(resolveSourceControlWriterModelSelection(settings, [unavailableProvider], null)).toBe(
      settings.textGenerationModelSelection,
    );
    expect(settings.sourceControlWriterModelSelection).toBe(sourceControlWriterModelSelection);
  });

  it("falls back from a writer provider that cannot generate application text", () => {
    const instanceId = ProviderInstanceId.make("acp_writer");
    const sourceControlWriterModelSelection = createModelSelection(instanceId, "default");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: {},
        },
      },
      sourceControlWriterModelSelection,
    };
    const incapableProvider = {
      instanceId,
      driver: ProviderDriverKind.make("acpRegistry"),
      supportsTextGeneration: false,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-07-27T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;

    expect(resolveSourceControlWriterModelSelection(settings, [incapableProvider], null)).toBe(
      settings.textGenerationModelSelection,
    );
    expect(settings.sourceControlWriterModelSelection).toBe(sourceControlWriterModelSelection);
  });

  it("falls back from a writer provider a project turned off, keeping it for other projects", () => {
    const instanceId = ProviderInstanceId.make("codex_writer");
    const projectId = ProjectId.make("project-a");
    const sourceControlWriterModelSelection = createModelSelection(instanceId, "gpt-5.4-mini");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
      sourceControlWriterModelSelection,
    };
    const provider = {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-07-27T00:00:00.000Z",
      availability: "available",
      models: [],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;

    expect(resolveSourceControlWriterModelSelection(settings, [provider], projectId)).toBe(
      settings.textGenerationModelSelection,
    );
    expect(resolveSourceControlWriterModelSelection(settings, [provider], null)).toBe(
      sourceControlWriterModelSelection,
    );
  });

  it("keeps a writer on an instance the project turned on while the machine has it off", () => {
    const instanceId = ProviderInstanceId.make("codex_writer");
    const projectId = ProjectId.make("project-a");
    const sourceControlWriterModelSelection = createModelSelection(instanceId, "gpt-5.4-mini");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false, config: {} },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
      sourceControlWriterModelSelection,
    };
    const provider = {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-07-27T00:00:00.000Z",
      availability: "available",
      models: [],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;

    expect(resolveSourceControlWriterModelSelection(settings, [provider], projectId)).toBe(
      sourceControlWriterModelSelection,
    );
    expect(resolveSourceControlWriterModelSelection(settings, [provider], null)).toBe(
      settings.textGenerationModelSelection,
    );
  });

  it("replaces providerInstances maps so omitted instance fields are cleared", () => {
    const codexId = ProviderInstanceId.make("codex");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex Work",
          accentColor: "#7c3aed",
          enabled: true,
          config: { homePath: "~/.codex" },
        },
      },
    };

    expect(
      applyServerSettingsPatch(current, {
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      }).providerInstances[codexId],
    ).toEqual({
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex Work",
      enabled: true,
      config: { homePath: "~/.codex" },
    });
  });

  it("keeps a project's providerInstances override when a patch entry omits the key", () => {
    // An older client that predates per-project provider overrides reads and
    // resends a project's whole entry without knowing about the field. A
    // naive whole-entry replace would silently wipe it.
    const instanceId = ProviderInstanceId.make("codex_work");
    const projectId = ProjectId.make("project-a");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [projectId]: {
          newWorktreesStartFromOrigin: true,
          providerInstances: { [instanceId]: { enabled: false } },
        },
      },
    };

    const patched = applyServerSettingsPatch(current, {
      projectSettingsOverrides: {
        [projectId]: { newWorktreesStartFromOrigin: false },
      },
    });

    expect(patched.projectSettingsOverrides[projectId]).toEqual({
      newWorktreesStartFromOrigin: false,
      providerInstances: { [instanceId]: { enabled: false } },
    });
  });

  // regression: #18334 a newer client must still see this server drop a key it does not know
  it("drops an override key this server does not know from a patch and keeps one it stored", () => {
    const projectId = ProjectId.make("project-a");
    const current = decodeServerSettings({
      projectSettingsFolded: true,
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, addedByNewerServer: 3 },
      },
    });
    const patch = decodeServerSettingsPatch({
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: false, addedByNewerServer: 4, addedByNewerClient: "x" },
      },
    });

    const updated = applyServerSettingsPatch(current, patch);
    expect(updated.projectSettingsOverrides[projectId]).toEqual({
      defaultAutoPull: false,
      addedByNewerServer: 3,
    });
    const reset = applyServerSettingsPatch(updated, {
      projectSettingsOverrides: { [projectId]: {} },
    });
    expect(reset.projectSettingsOverrides[projectId]).toEqual({ addedByNewerServer: 3 });
    expect(
      applyServerSettingsPatch(reset, {
        projectSettingsOverrides: { [projectId]: null },
      }).projectSettingsOverrides[projectId],
    ).toBeUndefined();
  });

  it("clears a project's providerInstances override when a patch entry sends an empty map", () => {
    // A client that knows the field expresses "clear every provider override
    // for this project" by sending providerInstances explicitly, not by
    // omitting it.
    const instanceId = ProviderInstanceId.make("codex_work");
    const projectId = ProjectId.make("project-a");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [projectId]: {
          newWorktreesStartFromOrigin: true,
          providerInstances: { [instanceId]: { enabled: false } },
        },
      },
    };

    const patched = applyServerSettingsPatch(current, {
      projectSettingsOverrides: {
        [projectId]: { newWorktreesStartFromOrigin: true, providerInstances: {} },
      },
    });

    expect(patched.projectSettingsOverrides[projectId]).toEqual({
      newWorktreesStartFromOrigin: true,
      providerInstances: {},
    });
  });

  it("replaces and removes individual usage prices without clobbering other models", () => {
    const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      usagePriceOverrides: { "example-model": { ...prices, cacheReadCostPerMillionTokens: 0.5 } },
    });
    const added = applyServerSettingsPatch(current, {
      usagePriceOverrides: { "other-model": prices },
    });
    const replaced = applyServerSettingsPatch(added, {
      usagePriceOverrides: { "example-model": prices },
    });
    expect(replaced.usagePriceOverrides).toEqual({
      "example-model": prices,
      "other-model": prices,
    });
    const removed = applyServerSettingsPatch(replaced, {
      usagePriceOverrides: { "example-model": null },
    });
    expect(removed.usagePriceOverrides).toEqual({ "other-model": prices });
    expect(current.usagePriceOverrides["example-model"]?.cacheReadCostPerMillionTokens).toBe(0.5);
  });

  it("stores background activity profiles as a versioned object and syncs legacy aliases", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "battery-saver",
        overrides: {},
      },
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "battery-saver",
      overrides: {},
    });
    expect(next.backgroundActivityProfile).toBe("battery-saver");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(0);
    expect(Duration.toMillis(next.providerHealthRefreshInterval)).toBe(
      Duration.toMillis(Duration.minutes(15)),
    );
  });

  it("turns legacy interval patches into custom background activity overrides", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      automaticGitFetchInterval: Duration.seconds(15),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "balanced",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(15),
      },
    });
    expect(resolveServerBackgroundActivitySettings(next).profile).toBe("balanced");
    expect(
      Duration.toMillis(resolveServerBackgroundActivitySettings(next).automaticGitFetchInterval),
    ).toBe(15_000);
  });

  it("preserves legacy background activity settings when applying an unrelated patch", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivityProfile: "performance" as const,
      automaticGitFetchInterval: Duration.seconds(7),
      providerHealthRefreshInterval: Duration.minutes(4),
    };

    const next = applyServerSettingsPatch(current, {
      sourceControlWriterModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
      ),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(7),
        providerHealthRefreshInterval: Duration.minutes(4),
      },
    });
    expect(next.backgroundActivityProfile).toBe("performance");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(7_000);
    expect(Duration.toMillis(next.providerHealthRefreshInterval)).toBe(240_000);
  });

  it("does not reactivate dormant overrides from a concrete profile", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivity: {
        schemaVersion: 1 as const,
        profile: "battery-saver" as const,
        overrides: {
          providerHealthRefreshInterval: Duration.seconds(5),
        },
      },
    };

    const next = applyServerSettingsPatch(current, {
      automaticGitFetchInterval: Duration.seconds(15),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(15),
      },
    });
  });

  it("prefers structured background activity settings over legacy aliases", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "battery-saver",
        overrides: {},
      },
      automaticGitFetchInterval: Duration.seconds(5),
      backgroundActivityProfile: "performance",
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "battery-saver",
      overrides: {},
    });
    expect(next.backgroundActivityProfile).toBe("battery-saver");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(0);
  });

  it("reconciles custom background activity back to a preset when overrides match the preset", () => {
    const custom = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      automaticGitFetchInterval: Duration.seconds(15),
    });
    const next = applyServerSettingsPatch(custom, {
      automaticGitFetchInterval: Duration.seconds(30),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "balanced",
      overrides: {},
    });
    expect(next.backgroundActivityProfile).toBe("balanced");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(30_000);
  });

  it("drops custom overrides that duplicate the base profile", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "custom",
        baseProfile: "balanced",
        overrides: {
          automaticGitFetchInterval: Duration.seconds(30),
        },
      },
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "balanced",
      overrides: {},
    });
  });

  it("replaces the complete background override record", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "custom",
        baseProfile: "balanced",
        overrides: {
          automaticGitFetchInterval: Duration.seconds(15),
          providerHealthRefreshInterval: Duration.minutes(3),
        },
      },
    });

    const next = applyServerSettingsPatch(current, {
      backgroundActivity: {
        overrides: {
          automaticGitFetchInterval: Duration.seconds(10),
        },
      },
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "balanced",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(10),
      },
    });
  });

  it("keeps interval overrides supplied with a profile patch", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivityProfile: "performance",
      automaticGitFetchInterval: Duration.seconds(0),
      providerHealthRefreshInterval: Duration.minutes(4),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(0),
        providerHealthRefreshInterval: Duration.minutes(4),
      },
    });
  });

  it("ignores overrides attached to a concrete background profile", () => {
    const resolved = resolveServerBackgroundActivitySettings({
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivity: {
        schemaVersion: 1,
        profile: "balanced",
        overrides: {
          pauseWhenOnBattery: true,
        },
      },
    });

    expect(resolved.pauseWhenOnBattery).toBe(false);
  });
});

describe("worktreesDirectory", () => {
  it("remembers previous custom locations so their worktrees stay managed", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { worktreesDirectory: "/a" });
    expect(first.previousWorktreesDirectories).toEqual([]);
    const second = applyServerSettingsPatch(first, { worktreesDirectory: "/b" });
    expect(second.previousWorktreesDirectories).toEqual(["/a"]);
    const reset = applyServerSettingsPatch(second, { worktreesDirectory: "" });
    expect(reset.previousWorktreesDirectories).toEqual(["/a", "/b"]);
    const back = applyServerSettingsPatch(reset, { worktreesDirectory: "/a" });
    expect(back.previousWorktreesDirectories).toEqual(["/b"]);
  });
});

describe("synchronized model preferences", () => {
  const provider = ProviderInstanceId.make("codex_work");
  const legacy = {
    favorites: [{ provider, model: "sol" }],
    providerModelPreferences: { [provider]: { hiddenModels: ["astra"], modelOrder: ["sol"] } },
  };

  it("keeps concurrent adds and removes of the same favorite idempotent", () => {
    const add = { setModelFavorites: [{ provider, model: "sol", favorite: true }] };
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, add);
    expect(applyServerSettingsPatch(first, add).favorites).toEqual([{ provider, model: "sol" }]);
    const remove = { setModelFavorites: [{ provider, model: "sol", favorite: false }] };
    const removed = applyServerSettingsPatch(first, remove);
    expect(applyServerSettingsPatch(removed, remove).favorites).toEqual([]);
  });

  it("preserves unrelated models and providers during bulk visibility and order edits", () => {
    const otherProvider = ProviderInstanceId.make("claude_work");
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerModelPreferences: {
        ...legacy.providerModelPreferences,
        [otherProvider]: { hiddenModels: ["opus"], modelOrder: ["sonnet", "opus"] },
      },
    });
    const mobile = applyServerSettingsPatch(initial, {
      setModelsHidden: [{ provider, model: "luna", hidden: true }],
    });
    const web = applyServerSettingsPatch(mobile, {
      setModelsHidden: [
        { provider, model: "astra", hidden: false },
        { provider, model: "sol", hidden: true },
      ],
      setProviderModelOrder: { provider, modelOrder: ["sol", "luna", "astra"] },
    });
    expect(web.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: ["luna", "sol"],
      modelOrder: ["sol", "luna", "astra"],
    });
    expect(web.providerModelPreferences?.[otherProvider]).toEqual(
      initial.providerModelPreferences?.[otherProvider],
    );
    expect(
      applyServerSettingsPatch(web, {
        setProviderModelOrder: { provider, modelOrder: [] },
      }).providerModelPreferences?.[provider],
    ).toEqual({ hiddenModels: ["luna", "sol"], modelOrder: [] });
  });

  it("migrates saved lists independently without claiming empty legacy lists", () => {
    expect(modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, {})).toBeNull();
    const patch = modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy)!;
    const migrated = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch);
    expect(resolveModelPreferences(migrated)).toEqual(legacy);
    expect(modelPreferencesMigrationPatch(migrated, legacy)).toBeNull();
    const favoritesOnly = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { favorites: [] });
    expect(modelPreferencesMigrationPatch(favoritesOnly, legacy)).toEqual({
      migrateModelPreferences: { providerModelPreferences: legacy.providerModelPreferences },
    });
  });

  it("keeps explicit clears when a delayed migration arrives from another device", () => {
    const staleMigration = modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy)!;
    const cleared = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      favorites: [],
      providerModelPreferences: {},
    });
    expect(
      resolveModelPreferences(applyServerSettingsPatch(cleared, staleMigration), legacy),
    ).toEqual({
      favorites: [],
      providerModelPreferences: {},
    });
  });

  it("replaces visibility records so showing every model clears removed entries", () => {
    const migrated = applyServerSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy)!,
    );
    const cleared = applyServerSettingsPatch(migrated, { providerModelPreferences: {} });
    expect(cleared.providerModelPreferences).toEqual({});
    expect(cleared.favorites).toEqual(legacy.favorites);
  });

  it("sets favorites without losing changes from other clients", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      setModelFavorites: [{ provider, model: "sol", favorite: true }],
    });
    const second = applyServerSettingsPatch(first, {
      setModelFavorites: [{ provider, model: "astra", favorite: true }],
      migrateModelPreferences: { favorites: [] },
    });
    expect(second.favorites).toEqual([
      { provider, model: "sol" },
      { provider, model: "astra" },
    ]);
    const removed = applyServerSettingsPatch(second, {
      setModelFavorites: [{ provider, model: "sol", favorite: false }],
    });
    expect(removed.favorites).toEqual([{ provider, model: "astra" }]);
    expect(
      applyServerSettingsPatch(removed, {
        setModelFavorites: [{ provider, model: "astra", favorite: false }],
      }).favorites,
    ).toEqual([]);
  });

  it("sets visibility against the latest state without replacing other models or their order", () => {
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerModelPreferences: legacy.providerModelPreferences,
    });
    const first = applyServerSettingsPatch(initial, {
      setModelsHidden: [{ provider, model: "sol", hidden: true }],
    });
    const second = applyServerSettingsPatch(first, {
      setModelsHidden: [{ provider, model: "luna", hidden: true }],
    });
    expect(second.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: ["astra", "sol", "luna"],
      modelOrder: ["sol"],
    });
    const restored = applyServerSettingsPatch(second, {
      setModelsHidden: [{ provider, model: "sol", hidden: false }],
    });
    expect(restored.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: ["astra", "luna"],
      modelOrder: ["sol"],
    });
    expect(
      applyServerSettingsPatch(restored, {
        setModelsHidden: [{ provider, model: "sol", hidden: false }],
      }).providerModelPreferences,
    ).toEqual(restored.providerModelPreferences);
    expect(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        setModelsHidden: [{ provider, model: "sol", hidden: true }],
      }).providerModelPreferences?.[provider]?.hiddenModels,
    ).toEqual(["sol"]);
  });

  it("keeps the same model on different provider instances as separate favorites", () => {
    const otherProvider = ProviderInstanceId.make("codex_personal");
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      setModelFavorites: [{ provider, model: "sol", favorite: true }],
    });
    const second = applyServerSettingsPatch(first, {
      setModelFavorites: [{ provider: otherProvider, model: "sol", favorite: true }],
    });
    expect(second.favorites).toEqual([
      { provider, model: "sol" },
      { provider: otherProvider, model: "sol" },
    ]);
    expect(
      applyServerSettingsPatch(second, {
        setModelFavorites: [{ provider, model: "sol", favorite: false }],
      }).favorites,
    ).toEqual([{ provider: otherProvider, model: "sol" }]);
  });

  it("keeps explicit edits when the same patch also carries a legacy migration", () => {
    const edited = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      ...modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy),
      favorites: [],
      providerModelPreferences: {},
    });
    expect(resolveModelPreferences(edited, legacy)).toEqual({
      favorites: [],
      providerModelPreferences: {},
    });
  });
});

describe("textGenerationWriters", () => {
  const codex = (instanceId: string, auth: ServerProvider["auth"]): ServerProvider => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "0.165.0",
    status: "ready",
    auth,
    checkedAt: "2026-11-09T00:00:00.000Z",
    models: [{ slug: "gpt-6-luna", name: "GPT-6 Luna", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });
 // A Mac signed in to Codex with compact: the default instance is an API-key account holding no login.
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [ProviderInstanceId.make("codex-account-chatgpt")]: { driver: ProviderDriverKind.make("codex"), config: {} },
    },
  };
  const signedOut = codex("codex", { status: "unauthenticated" });
  const chatGpt = codex("codex-account-chatgpt", { status: "authenticated", type: "chatgpt" });

  it("passes over Settings' model when it has no login, for the PR guide's cheap writers", () => {
    expect(textGenerationWriters(settings, [signedOut, chatGpt], null)).toEqual([
      { instanceId: ProviderInstanceId.make("codex-account-chatgpt"), model: "gpt-6-luna" },
    ]);
  });

  it("tries Settings' model first while it can run, then the others once each", () => {
    const signedIn = codex("codex", { status: "authenticated", type: "chatgpt" });
    expect(textGenerationWriters(settings, [signedIn, chatGpt], null).map((writer) => writer.instanceId)).toEqual([
      ProviderInstanceId.make("codex"),
      ProviderInstanceId.make("codex-account-chatgpt"),
    ]);
  });

  it("keeps Settings' model when nothing can run, so the failure names what the person chose", () => {
    expect(textGenerationWriters(settings, [signedOut], null)).toEqual([settings.textGenerationModelSelection]);
  });

  it("keeps Settings' model while its provider's first probe is still running", () => {
    const checking = { ...codex("codex", { status: "unknown" }), installed: false, probePending: true };
    expect(textGenerationWriters(settings, [checking, chatGpt], null)[0]).toEqual(settings.textGenerationModelSelection);
    expect(
      resolveSourceControlWriterModelSelection(
        { ...settings, sourceControlWriterModelSelection: settings.textGenerationModelSelection },
        [checking, chatGpt],
        null,
      ),
    ).toEqual(settings.textGenerationModelSelection);
  });

  it("never picks a writer the project turned off", () => {
    const projectId = ProjectId.make("project-without-chatgpt");
    const scoped = {
      ...settings,
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [ProviderInstanceId.make("codex-account-chatgpt")]: { enabled: false } } },
      },
    } as typeof settings;
    expect(textGenerationWriters(scoped, [signedOut, chatGpt], projectId)).toEqual([scoped.textGenerationModelSelection]);
    expect(textGenerationWriters(scoped, [signedOut, chatGpt], null)[0]?.instanceId).toBe(
      ProviderInstanceId.make("codex-account-chatgpt"),
    );
  });

  it("gives commit text with no writer of its own the same signed-in writer", () => {
    expect(resolveSourceControlWriterModelSelection(settings, [signedOut, chatGpt], null).instanceId).toBe(
      ProviderInstanceId.make("codex-account-chatgpt"),
    );
  });
});
