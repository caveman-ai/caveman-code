import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@caveman-app/protocol";
import { afterEach } from "vitest";

import { compileClaudeModelSelection } from "../claudeModelOptions.ts";
import {
  type ClaudeCatalogModel,
  type ClaudeModelCatalog,
  forgetLearnedClaudeModels,
  knownClaudeModelCatalog,
  parseClaudeReportedModels,
  rememberClaudeModels,
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeModelsForVersion,
  resolveClaudeUpdateRequiredModels,
  withReportedClaudeModels,
} from "./ClaudeModelCatalog.ts";

const opusEffort = {
  id: "effort",
  label: "Reasoning",
  type: "select" as const,
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra High" },
    { id: "max", label: "Max" },
    { id: "ultracode", label: "Ultracode" },
  ],
};
const fastMode = { id: "fastMode", label: "Fast Mode", type: "boolean" as const };

const entry = (
  slug: string,
  name: string,
  extra: Partial<ClaudeCatalogModel["model"]> = {},
  runtime: ClaudeCatalogModel["runtime"] = {},
  compatibility: ClaudeCatalogModel["compatibility"] = {},
): ClaudeCatalogModel => ({
  model: { slug, name, isCustom: false, capabilities: { optionDescriptors: [] }, ...extra },
  runtime,
  compatibility,
});

/** A synthetic manifest catalog: Opus 5.5 current and the default, Opus 5 legacy, Sonnet 5.5 current. */
const catalog: ClaudeModelCatalog = {
  models: [
    entry(
      "claude-opus-5-5",
      "Claude Opus 5.5",
      {
        aliases: ["opus"],
        isDefault: true,
        capabilities: { optionDescriptors: [opusEffort, fastMode] },
      },
      { effortMap: { ultracode: "xhigh" }, fixedContextWindowTokens: 1_000_000 },
      { minVersion: "2.1.280" },
    ),
    entry("claude-sonnet-5-5", "Claude Sonnet 5.5", { aliases: ["sonnet"] }),
    entry("claude-opus-5", "Claude Opus 5", { isLegacy: true }),
  ],
};

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const slugs = (c: ClaudeModelCatalog) => c.models.map((e) => e.model.slug);
const model = (c: ClaudeModelCatalog, slug: string) => c.models.find((e) => e.model.slug === slug)!;

afterEach(() => forgetLearnedClaudeModels());

describe("the installed claude's own model list", () => {
  it("reads the Anthropic models from the SDK's initialize rows", () => {
    // The shape `claude` 2.1.318 answered with, a person's custom option included.
    const rows = parseClaudeReportedModels([
      {
        value: "default",
        resolvedModel: "claude-opus-5-5",
        supportedEffortLevels: EFFORTS,
        supportsFastMode: true,
      },
      {
        value: "opus",
        resolvedModel: "claude-opus-5-5",
        supportedEffortLevels: EFFORTS,
        supportsFastMode: true,
      },
      {
        value: "claude-fable-5-1[1m]",
        resolvedModel: "claude-fable-5-1",
        supportedEffortLevels: EFFORTS,
      },
      { value: "haiku", resolvedModel: "claude-haiku-5-5", supportsEffort: false },
      {
        value: "caveman-auto[1m]",
        resolvedModel: "caveman-auto[1m]",
        supportedEffortLevels: EFFORTS,
      },
      { value: "sonnet" },
    ]);
    assert.deepStrictEqual(rows, [
      { slug: "claude-opus-5-5", alias: "default", effortLevels: EFFORTS, fastMode: true },
      { slug: "claude-opus-5-5", alias: "opus", effortLevels: EFFORTS, fastMode: true },
      { slug: "claude-fable-5-1", effortLevels: EFFORTS, fastMode: false },
      { slug: "claude-haiku-5-5", alias: "haiku", effortLevels: [], fastMode: false },
    ]);
  });

  it("leaves the catalog alone when the CLI lists only what it knows", () => {
    const live = withReportedClaudeModels(
      catalog,
      parseClaudeReportedModels([
        { value: "default", resolvedModel: "claude-opus-5-5" },
        { value: "opus", resolvedModel: "claude-opus-5-5" },
        { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
      ]),
    );
    assert.deepStrictEqual(
      live.models.map((e) => e.model),
      catalog.models.map((e) => e.model),
    );
  });

  it("lists a new version of a family the day the CLI has it, on its family's options", () => {
    const live = withReportedClaudeModels(
      catalog,
      parseClaudeReportedModels([
        {
          value: "default",
          resolvedModel: "claude-opus-6",
          supportedEffortLevels: ["low", "medium", "high", "xhigh"],
          supportsFastMode: false,
        },
        {
          value: "opus",
          resolvedModel: "claude-opus-6",
          supportedEffortLevels: ["low", "medium", "high", "xhigh"],
          supportsFastMode: false,
        },
        { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
      ]),
    );
    assert.deepStrictEqual(slugs(live), [
      "claude-opus-6",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5",
    ]);
    const opus6 = model(live, "claude-opus-6");
    assert.strictEqual(opus6.model.name, "Claude Opus 6");
    assert.deepStrictEqual(opus6.model.aliases, ["opus"]);
    assert.strictEqual(opus6.model.isDefault, true);
    assert.strictEqual(opus6.model.isLegacy, undefined);
    // Max is not offered by this CLI; Ultracode runs on xhigh, which is. No fast mode.
    assert.deepStrictEqual(opus6.model.capabilities, {
      optionDescriptors: [
        { ...opusEffort, options: opusEffort.options.filter((o) => o.id !== "max") },
      ],
    });
    assert.deepStrictEqual(opus6.runtime, model(catalog, "claude-opus-5-5").runtime);

    const opus55 = model(live, "claude-opus-5-5");
    assert.strictEqual(opus55.model.isLegacy, true);
    assert.strictEqual(opus55.model.isDefault, undefined);
    assert.strictEqual(opus55.model.aliases, undefined);
    assert.strictEqual(model(live, "claude-sonnet-5-5").model.isLegacy, undefined);
  });

  it("keeps the model the CLI still calls opus current when it also lists a newer one by id", () => {
    // `claude` 2.1.318 with ANTHROPIC_CUSTOM_MODEL_OPTION=claude-opus-6 answered this way.
    const live = withReportedClaudeModels(
      catalog,
      parseClaudeReportedModels([
        { value: "default", resolvedModel: "claude-opus-5-5" },
        { value: "opus", resolvedModel: "claude-opus-5-5" },
        { value: "claude-opus-6", resolvedModel: "claude-opus-6", supportedEffortLevels: EFFORTS },
      ]),
    );
    assert.deepStrictEqual(
      live.models.filter((e) => !e.model.isLegacy).map((e) => e.model.slug),
      ["claude-opus-6", "claude-opus-5-5", "claude-sonnet-5-5"],
    );
    assert.strictEqual(model(live, "claude-opus-5-5").model.isDefault, true);
    assert.deepStrictEqual(model(live, "claude-opus-5-5").model.aliases, ["opus"]);
    assert.strictEqual(model(live, "claude-opus-5").model.isLegacy, true);
  });

  it("runs a listed model whatever minimum version the manifest names", () => {
    const rows = parseClaudeReportedModels([{ value: "opus", resolvedModel: "claude-opus-5-5" }]);
    assert.notInclude(
      resolveClaudeModelsForVersion(catalog, "2.1.200").map((m) => m.slug),
      "claude-opus-5-5",
    );
    const live = withReportedClaudeModels(catalog, rows);
    assert.include(
      resolveClaudeModelsForVersion(live, "2.1.200").map((m) => m.slug),
      "claude-opus-5-5",
    );
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(live, "2.1.200"), []);
  });

  it("gives a family no release has seen the CLI's own effort levels and leaves the default to Claude Code", () => {
    const live = withReportedClaudeModels(
      catalog,
      parseClaudeReportedModels([
        {
          value: "claude-mythos-1",
          supportedEffortLevels: ["low", "high"],
          supportsFastMode: true,
        },
      ]),
    );
    assert.strictEqual(slugs(live)[0], "claude-mythos-1");
    assert.deepStrictEqual(model(live, "claude-mythos-1").model, {
      slug: "claude-mythos-1",
      name: "Claude Mythos 1",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
          fastMode,
        ],
      },
    });
    assert.deepStrictEqual(
      model(live, "claude-opus-5-5").model,
      model(catalog, "claude-opus-5-5").model,
    );
  });

  it("lets every session resolve a learned model's options, not only the picker", () => {
    const live = withReportedClaudeModels(
      catalog,
      parseClaudeReportedModels([
        {
          value: "opus",
          resolvedModel: "claude-opus-6",
          supportedEffortLevels: EFFORTS,
          supportsFastMode: true,
        },
      ]),
    );
    const selection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-6",
      options: [
        { id: "effort", value: "ultracode" },
        { id: "fastMode", value: true },
      ],
    };
    assert.strictEqual(
      knownClaudeModelCatalog().models.some((e) => e.model.slug === "claude-opus-6"),
      false,
    );
    rememberClaudeModels(live);
    const compiled = compileClaudeModelSelection(selection);
    assert.strictEqual(compiled.apiModelId, "claude-opus-6");
    assert.strictEqual(compiled.effort, "xhigh");
    assert.deepStrictEqual(compiled.settings, { fastMode: true, ultracode: true });
    assert.strictEqual(
      resolveClaudeCatalogContextWindowTokens(knownClaudeModelCatalog(), selection),
      1_000_000,
    );
  });
});
