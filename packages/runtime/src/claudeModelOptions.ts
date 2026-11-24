// ), apps/server/src/claudeModelOptions.ts @ ab3a3cd1.
import type { ModelSelection } from "@caveman-app/protocol";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@caveman-app/shared/model";

import {
  getClaudeCatalogModelCapabilities,
  isClaudeCatalogUltracodeEffort,
  knownClaudeModelCatalog,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  type ClaudeModelCatalog,
} from "./provider/ClaudeModelCatalog.ts";

export interface CompiledClaudeModelSelection {
  readonly apiModelId: string;
  readonly effort: string | undefined;
  readonly settings: Readonly<Record<string, boolean>>;
  readonly queryIdentity: string;
}

/** Compile every Claude model option at the provider boundary. */
export function compileClaudeModelSelection(
  selection: ModelSelection,
  catalog: ClaudeModelCatalog = knownClaudeModelCatalog(),
): CompiledClaudeModelSelection {
  const capabilities = getClaudeCatalogModelCapabilities(catalog, selection.model);
  const descriptors = getProviderOptionDescriptors({ caps: capabilities });
  const supportsBoolean = (id: string) =>
    descriptors.some((descriptor) => descriptor.type === "boolean" && descriptor.id === id);
  const rawEffort = getModelSelectionStringOptionValue(selection, "effort");
  const resolvedEffort = resolveClaudeCatalogEffort(catalog, selection.model, rawEffort);
  const effort = normalizeClaudeCatalogEffort(catalog, resolvedEffort, selection.model);
  const fastMode = supportsBoolean("fastMode")
    ? (getModelSelectionBooleanOptionValue(selection, "fastMode") ?? false)
    : undefined;
  const thinking = supportsBoolean("thinking")
    ? getModelSelectionBooleanOptionValue(selection, "thinking")
    : undefined;
  const settings = {
    ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
    ...(isClaudeCatalogUltracodeEffort(resolvedEffort) ? { ultracode: true } : {}),
  };
  const apiModelId = resolveClaudeCatalogApiModelId(catalog, selection);
  return {
    apiModelId,
    effort,
    settings,
    queryIdentity: JSON.stringify({ apiModelId, effort: effort ?? null, settings }),
  };
}
