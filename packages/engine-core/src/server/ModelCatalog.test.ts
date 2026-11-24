// ), packages/provider-core/src/server/ModelCatalog.test.ts @ ab3a3cd1.
import { assert, describe, it } from "@effect/vitest";
import type { ServerProviderModel } from "@caveman-app/protocol";

import * as ModelCatalog from "./ModelCatalog.ts";

/**
 * Covers catalog semantics with synthetic models. Real model data lives in the
 * server's model-manifest.json and is not asserted here.
 */
const model = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
  slug: "model-test",
  name: "Model Test",
  isCustom: false,
  capabilities: null,
  ...overrides,
});

const catalogModel = (
  slug: string,
  status: ModelCatalog.ProviderCatalogModel["status"],
): ModelCatalog.ProviderCatalogModel => ({
  slug,
  name: slug,
  status,
  capabilities: null,
  adapter: undefined,
  profileAdapter: undefined,
});

/** Strips a vendor prefix, the way a driver maps qualified slugs to catalog families. */
const prefixFamily: ModelCatalog.CatalogMatching = {
  family: (slug) => slug.replace(/^vendor\./, ""),
};

describe("classifyCatalogModels", () => {
  it("flags only known legacy models, clears stale flags, and skips custom models", () => {
    const catalog: ModelCatalog.ProviderCatalog = {
      models: [catalogModel("old-model", "legacy")],
      defaultChatModel: undefined,
    };
    const models = [
      model({ slug: "current-a" }),
      // Stale flag from a previous classification pass must be cleared.
      model({ slug: "current-b", isLegacy: true }),
      model({ slug: "old-model" }),
      // Custom models are user-defined and never reclassified.
      model({ slug: "my-own-model", isCustom: true, isLegacy: true }),
    ];
    assert.deepStrictEqual(
      ModelCatalog.classifyCatalogModels(models, catalog).map((entry) => [
        entry.slug,
        entry.isLegacy ?? false,
      ]),
      [
        ["current-a", false],
        ["current-b", false],
        ["old-model", true],
        ["my-own-model", true],
      ],
    );
  });

  it("matches qualified slugs through the driver's family without changing their ids", () => {
    const catalog: ModelCatalog.ProviderCatalog = {
      models: [catalogModel("model-old", "legacy")],
      defaultChatModel: undefined,
    };
    assert.deepStrictEqual(
      ModelCatalog.classifyCatalogModels(
        [model({ slug: "vendor.model-test", isLegacy: true }), model({ slug: "vendor.model-old" })],
        catalog,
        prefixFamily,
      ).map((entry) => [entry.slug, entry.isLegacy ?? false]),
      [
        ["vendor.model-test", false],
        ["vendor.model-old", true],
      ],
    );
  });

  it("keeps discovered models current when the driver has no catalog", () => {
    assert.deepStrictEqual(
      ModelCatalog.classifyCatalogModels([model({ slug: "new", isLegacy: true })], undefined),
      [model({ slug: "new" })],
    );
  });
});

describe("applyCatalogDefault", () => {
  it("moves the default flag and its aliases to the catalog's chat default", () => {
    const catalog: ModelCatalog.ProviderCatalog = {
      models: [catalogModel("model-new", "current")],
      defaultChatModel: "model-new",
    };
    const models = [
      model({ slug: "model-old", isDefault: true, aliases: ["provider-default"] }),
      model({ slug: "model-new" }),
    ];
    assert.deepStrictEqual(ModelCatalog.applyCatalogDefault(models, catalog), [
      model({ slug: "model-old" }),
      model({ slug: "model-new", isDefault: true, aliases: ["provider-default"] }),
    ]);
    // The account does not offer the catalog default: keep the runtime's choice.
    assert.deepStrictEqual(
      ModelCatalog.applyCatalogDefault(models.slice(0, 1), catalog),
      models.slice(0, 1),
    );
  });

  it("resolves the catalog default to a qualified discovered model", () => {
    const catalog: ModelCatalog.ProviderCatalog = {
      models: [],
      defaultChatModel: "model-test",
    };
    const models = [
      model({ slug: "vendor.model-old", isDefault: true }),
      model({ slug: "vendor.model-test" }),
    ];
    assert.strictEqual(
      ModelCatalog.applyCatalogDefault(models, catalog, prefixFamily).find(
        (entry) => entry.isDefault,
      )?.slug,
      "vendor.model-test",
    );
  });
});

describe("withSuccessors", () => {
  const entry = (
    slug: string,
    status: ModelCatalog.ProviderCatalogModel["status"],
    over: Partial<ModelCatalog.ProviderCatalogModel> = {},
  ): ModelCatalog.ProviderCatalogModel => ({
    ...catalogModel(slug, status),
    adapter: { from: slug },
    profileAdapter: { profile: slug },
    ...over,
  });
  const catalog: ModelCatalog.ProviderCatalog = {
    models: [
      entry("claude-opus-5-5", "current", { aliases: ["opus", "opus-5.5"] }),
      entry("claude-fable-5-1", "current", { aliases: ["fable", "fable-5.1"], shortName: "Fable 5.1", badge: "new" }),
      entry("claude-fable-5", "legacy"),
      entry("claude-opus-4-8", "legacy"),
      entry("claude-mythos-1", "legacy"),
    ],
    defaultChatModel: "claude-opus-5-5",
  };
  const release = (slug: string, name = slug) => ({ slug, name });

  it("adds a family's newest release on its newest model's profile, and turns the one it replaces legacy", () => {
    const next = ModelCatalog.withSuccessors(catalog, [
      release("claude-fable-5-2", "Claude Fable 5.2"),
      release("claude-fable-5-1"),
      release("claude-fable-5"),
    ]);
    assert.deepEqual(
      next.models.map((m) => [m.slug, m.status]),
      [
        ["claude-opus-5-5", "current"],
        ["claude-fable-5-2", "current"],
        ["claude-fable-5-1", "legacy"],
        ["claude-fable-5", "legacy"],
        ["claude-opus-4-8", "legacy"],
        ["claude-mythos-1", "legacy"],
      ],
    );
    const added = next.models[1]!;
    assert.deepEqual(added, {
      slug: "claude-fable-5-2",
      name: "Claude Fable 5.2",
      aliases: ["fable"],
      status: "current",
      discovered: true,
      capabilities: null,
      adapter: { from: "claude-fable-5-1" },
      profileAdapter: { profile: "claude-fable-5-1" },
    });
    // The version's own alias stays with it; the family's moves; no stale badge or short name is carried.
    assert.deepEqual(next.models[2]!.aliases, ["fable-5.1"]);
    assert.equal(next.models[2]!.badge, undefined);
  });

  it("reads as new for a week after its release day, and never without one", () => {
    const day = Date.parse("2026-11-09");
    const fable = (releasedAt?: string, nowMs = day) =>
      ModelCatalog.withSuccessors(catalog, [{ ...release("claude-fable-5-2"), ...(releasedAt ? { releasedAt } : {}) }], nowMs)
        .models.find((m) => m.slug === "claude-fable-5-2")!.badge;
    assert.equal(fable("2026-11-09"), "new");
    assert.equal(fable("2026-11-09", day + ModelCatalog.NEW_BADGE_MS - 1), "new");
    assert.equal(fable("2026-11-09", day + ModelCatalog.NEW_BADGE_MS), undefined);
    assert.equal(fable("2026-11-10"), undefined, "not before its day");
    assert.equal(fable(undefined), undefined);
  });

  it("takes only the newest of several releases, and skips dated copies, `-latest` aliases and previews", () => {
    const next = ModelCatalog.withSuccessors(catalog, [
      release("claude-fable-5-2"),
      release("claude-fable-5-3"),
      release("claude-fable-5-1-20261001"),
      release("claude-fable-latest"),
      release("claude-fable-6-preview"),
    ]);
    assert.deepEqual(
      next.models.filter((m) => m.discovered).map((m) => m.slug),
      ["claude-fable-5-3"],
    );
  });

  it("keeps the chat default current, adds nothing older, known or of a family with no current model", () => {
    const next = ModelCatalog.withSuccessors(catalog, [
      release("claude-opus-5-6"),
      release("claude-opus-5-1"),
      release("opus-5.5"),
      release("claude-mythos-2"),
      release("claude-haiku-6"),
    ]);
    assert.deepEqual(
      next.models.filter((m) => m.status === "current").map((m) => m.slug),
      ["claude-opus-5-6", "claude-opus-5-5", "claude-fable-5-1"],
    );
    assert.equal(next.defaultChatModel, "claude-opus-5-5");
    assert.deepEqual(next.models.find((m) => m.slug === "claude-opus-5-5")!.aliases, ["opus", "opus-5.5"]);
    assert.equal(next.models.find((m) => m.slug === "claude-opus-5-6")!.aliases, undefined);
    assert.strictEqual(ModelCatalog.withSuccessors(catalog, [release("claude-opus-5-5")]), catalog);
  });
});
