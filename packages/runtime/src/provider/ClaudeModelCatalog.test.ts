// ), apps/server/src/provider/ClaudeModelCatalog.test.ts @ ab3a3cd1.
import { afterEach, assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@caveman-app/protocol";
import { setModelsDevFacts } from "@caveman-app/engine-core/server/modelsDev";

import { compileClaudeModelSelection } from "../claudeModelOptions.ts";

import { hasValidClaudeManifestAdapters } from "./ClaudeModelManifest.ts";
import { resolveProviderCatalog, type ModelManifestData } from "./ModelManifest.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  claudeModelCatalogNow,
  formatClaudeVersionUpgradeMessage,
  rememberClaudeModelCatalog,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeCatalogEffort,
  resolveClaudeModelCatalog,
  resolveClaudeModelsForVersion,
  resolveClaudeModelSlug,
  resolveClaudeUpdateRequiredModels,
  scopeClaudeModelCatalog,
  withNewestClaudeCode,
} from "./ClaudeModelCatalog.ts";

/**
 * Test policy: adding or changing a real Claude model in model-manifest.json
 * must not add or update tests here. These synthetic fixtures cover resolver
 * behavior once. Add a test only when Claude adapter semantics change, such
 * as introducing a new compatibility rule or dispatch mapping type.
 */

const manifest = (): ModelManifestData => ({
  version: 1,
  currentModels: {},
  providers: {
    claudeAgent: {
      profiles: {
        synthetic: {
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [{ id: "extreme", label: "Extreme", isDefault: true }],
              },
              {
                id: "contextWindow",
                label: "Context Window",
                type: "select",
                options: [
                  { id: "large", label: "Large", isDefault: true },
                  { id: "small", label: "Small" },
                ],
              },
            ],
          },
          adapter: {
            claudeCode: {
              effortMap: { extreme: "high" },
              modelSuffixes: { contextWindow: { large: "[large]" } },
            },
          },
        },
      },
      models: [
        {
          slug: "claude-synthetic-next",
          name: "Claude Synthetic Next",
          aliases: ["synthetic"],
          status: "current",
          profile: "synthetic",
          adapter: { claudeCode: { minVersion: "3.2.0" } },
        },
      ],
    },
  },
});

const CLAUDE = ProviderDriverKind.make("claudeAgent");

/** Resolves Claude's catalog the way the driver does: through its manifest catalog entry. */
const catalogFromManifest = (data: ModelManifestData) =>
  resolveClaudeModelCatalog(resolveProviderCatalog(data, CLAUDE) ?? undefined);

describe("Claude model catalog", () => {
  it("resolves capacity from selected options and fixed catalog windows without guessing custom models", () => {
    const source = manifest();
    const profile = source.providers!.claudeAgent!.profiles.synthetic!;
    const catalog = catalogFromManifest({
      ...source,
      providers: {
        claudeAgent: {
          ...source.providers!.claudeAgent!,
          profiles: {
            fixed: {
              capabilities: { optionDescriptors: [] },
              adapter: { claudeCode: { fixedContextWindowTokens: 64_000 } },
            },
            synthetic: {
              ...profile,
              adapter: { claudeCode: { contextWindowTokens: { large: 1_000_000, small: 32_000 } } },
            },
          },
          models: [
            ...source.providers!.claudeAgent!.models,
            {
              slug: "fixed",
              name: "Fixed",
              status: "current",
              profile: "fixed",
            },
          ],
        },
      },
    });
    const selection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "synthetic" };
    assert.equal(resolveClaudeCatalogContextWindowTokens(catalog, selection), 1_000_000);
    assert.equal(
      resolveClaudeCatalogContextWindowTokens(catalog, {
        ...selection,
        options: [{ id: "contextWindow", value: "small" }],
      }),
      32_000,
    );
    assert.equal(
      resolveClaudeCatalogContextWindowTokens(catalog, { ...selection, model: "fixed" }),
      64_000,
    );
    assert.isUndefined(
      resolveClaudeCatalogContextWindowTokens(catalog, { ...selection, model: "custom" }),
    );
  });

  it("filters models at runtime-version boundaries and derives the upgrade message", () => {
    const catalog = catalogFromManifest(manifest());
    assert.deepStrictEqual(resolveClaudeModelsForVersion(catalog, "3.1.9"), []);
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next"],
    );
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "3.1.9"), [
      { slug: "claude-synthetic-next", name: "Claude Synthetic Next", minVersion: "3.2.0" },
    ]);
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "3.2.0"), []);
    assert.strictEqual(
      formatClaudeVersionUpgradeMessage(catalog, "3.1.9"),
      "Claude Agent v3.1.9 is too old for Claude Synthetic Next. Upgrade to v3.2.0 or newer to access it.",
    );
  });

  it("resolves aliases and declarative adapter mappings", () => {
    const base = manifest();
    const input: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          models: [
            {
              slug: "claude-synthetic-collision",
              name: "Claude Synthetic Collision",
              aliases: ["claude-synthetic-next"],
              status: "current",
            },
            ...base.providers!.claudeAgent!.models,
          ],
        },
      },
    };
    const catalog = catalogFromManifest(input);
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "claude-synthetic-next");
    assert.strictEqual(
      resolveClaudeModelSlug(catalog, "claude-synthetic-next"),
      "claude-synthetic-next",
    );
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "extreme", "synthetic"), "high");
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "synthetic",
      }),
      "claude-synthetic-next[large]",
    );
  });

  it("rejects malformed adapter mappings", () => {
    const base = manifest();
    const malformed: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          profiles: {
            ...base.providers!.claudeAgent!.profiles,
            synthetic: {
              ...base.providers!.claudeAgent!.profiles.synthetic!,
              adapter: { claudeCode: { effortMap: { extreme: 123 } } },
            },
          },
        },
      },
    };
    assert.isFalse(hasValidClaudeManifestAdapters(malformed));
  });

  it("preserves only SDK effort levels for uncatalogued models", () => {
    const catalog = catalogFromManifest(manifest());
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      assert.strictEqual(resolveClaudeCatalogEffort(catalog, "custom", ` ${effort} `), effort);
    }
    for (const effort of [undefined, null, "", "  ", "brutal", "extreme", "HIGH", "ultrathink"]) {
      assert.isUndefined(resolveClaudeCatalogEffort(catalog, "custom", effort));
    }
  });

  it("appends custom models with their own descriptors and keeps bare slugs opaque", () => {
    const catalog = scopeClaudeModelCatalog(catalogFromManifest(manifest()), [
      "synthetic",
      {
        slug: "claude-custom-tuned",
        name: "Tuned",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "gentle", label: "Gentle", isDefault: true },
                { id: "brutal", label: "Brutal" },
              ],
            },
          ],
        },
      },
    ]);

    // The bare custom slug shadows the built-in alias, so it no longer resolves to it.
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "synthetic");
    assert.isUndefined(resolveClaudeCatalogEffort(catalog, "synthetic", "extreme"));
    assert.strictEqual(resolveClaudeCatalogEffort(catalog, "synthetic", "max"), "max");
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "max", "synthetic"), "max");

    // The entry with descriptors resolves user-defined effort ids and passes
    // them through untouched (no effortMap, no model suffix).
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "brutal"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "bogus"),
      "gentle",
    );
    assert.strictEqual(
      normalizeClaudeCatalogEffort(catalog, "brutal", "claude-custom-tuned"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-custom-tuned",
        options: [{ id: "effort", value: "brutal" }],
      }),
      "claude-custom-tuned",
    );
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next", "claude-custom-tuned"],
    );
  });
});

describe("a Claude model Anthropic released after this build", () => {
  afterEach(() => {
    setModelsDevFacts(undefined);
    rememberClaudeModelCatalog(undefined);
  });
  const releases = [{ slug: "claude-synthetic-next-2", name: "Claude Synthetic Next 2" }];
  const found = () =>
    resolveClaudeModelCatalog(resolveProviderCatalog(manifest(), CLAUDE) ?? undefined, releases);

  it("runs on its family's profile and takes the family's alias", () => {
    const catalog = found();
    assert.deepStrictEqual(
      catalog.models.map((entry) => [entry.model.slug, entry.model.isLegacy ?? false, entry.discovered ?? false]),
      [
        ["claude-synthetic-next-2", false, true],
        ["claude-synthetic-next", true, false],
      ],
    );
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "claude-synthetic-next-2");
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "extreme", "claude-synthetic-next-2"), "high");
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-synthetic-next-2",
      }),
      "claude-synthetic-next-2[large]",
    );
  });

  it("needs the newest Claude Code, and its family's minimum without one to go by", () => {
    const catalog = withNewestClaudeCode(found(), "3.4.0");
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.3.0").map((model) => model.slug),
      ["claude-synthetic-next"],
    );
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "3.3.0"), [
      { slug: "claude-synthetic-next-2", name: "Claude Synthetic Next 2", minVersion: "3.4.0" },
    ]);
    assert.include(
      resolveClaudeModelsForVersion(catalog, "3.4.0").map((model) => model.slug),
      "claude-synthetic-next-2",
    );
    // No newest version known, or one below the family's own minimum: the family's minimum stands.
    for (const newest of [null, "3.0.0"]) {
      const kept = withNewestClaudeCode(found(), newest);
      assert.strictEqual(kept.models[0]!.compatibility.minVersion, "3.2.0");
    }
    // A catalog with nothing found is returned as it is.
    assert.strictEqual(withNewestClaudeCode(BUNDLED_CLAUDE_MODEL_CATALOG, "9.9.9"), BUNDLED_CLAUDE_MODEL_CATALOG);
  });

  it("compiles in a session as its family's newest bundled model does, as soon as models.dev lists it", () => {
    const fable = BUNDLED_CLAUDE_MODEL_CATALOG.models.find(
      (entry) => entry.model.slug.startsWith("claude-fable-") && !entry.model.isLegacy,
    )!.model.slug;
    const select = (model: string) => ({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model,
      options: [{ id: "effort", value: "ultracode" }],
    });
    const before = compileClaudeModelSelection(select("claude-fable-9-9"));
    assert.strictEqual(before.effort, undefined, "unknown before models.dev lists it");
    setModelsDevFacts({
      anthropic: {
        "claude-fable-9-9": { name: "Claude Fable 9.9", deprecated: false, reasoning: true, image: true },
      },
    });
    assert.ok(claudeModelCatalogNow().models.some((entry) => entry.model.slug === "claude-fable-9-9"));
    const after = compileClaudeModelSelection(select("claude-fable-9-9"));
    const template = compileClaudeModelSelection(select(fable), BUNDLED_CLAUDE_MODEL_CATALOG);
    assert.strictEqual(after.apiModelId, "claude-fable-9-9");
    assert.strictEqual(after.effort, template.effort);
    assert.deepStrictEqual(after.settings, template.settings);
  });

  it("compiles in a session against the catalog the picker was built from, a remote manifest's included", () => {
    setModelsDevFacts({
      anthropic: {
        "claude-synthetic-next-2": { name: "Claude Synthetic Next 2", deprecated: false, reasoning: true, image: true },
      },
    });
    // A manifest other than the bundled one, as a remote manifest would be: the picker's catalog, so the session's.
    rememberClaudeModelCatalog(catalogFromManifest(manifest()));
    const select = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-synthetic-next-2", options: [{ id: "effort", value: "extreme" }] };
    const compiled = compileClaudeModelSelection(select);
    assert.strictEqual(compiled.effort, "high");
    assert.strictEqual(compiled.apiModelId, "claude-synthetic-next-2[large]");
  });
});
