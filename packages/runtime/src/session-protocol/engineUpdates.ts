// Models an engine's installed CLI is too old for, and bringing Claude Code up to them.
//
// A provider lists only the models its installed CLI can run (ClaudeModelCatalog resolveClaudeModelsForVersion: the
// manifest's minVersion per model) and keeps the newer ones apart (ServerProvider.updateRequiredModels). The picker
// used to drop those, so a Claude Code a few weeks old showed "up to Opus 5" with no word of Opus 5.5. Now engine.list
// lists them, saying what they need, and Claude Code, which updates itself by default, is updated by its own updater
// (ProviderMaintenanceRunner: `claude update`, or the package manager that installed it) as soon as the runtime sees
// it is behind. Until then such a model still runs on the older CLI, which says it doesn't know it and keeps the
// session within 200K tokens.

import type { ServerProvider } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ProviderMaintenanceRunner } from "../provider/providerMaintenanceRunner.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

/** The CLI each harness runs, by driver, as the person knows it. */
const CLI: Readonly<Record<string, string>> = { claudeAgent: "Claude Code", codex: "the Codex CLI" };
/** How the person updates it themselves when the app can't. */
const UPDATE_COMMAND: Readonly<Record<string, string>> = { claudeAgent: "claude update", codex: "npm install -g @openai/codex@latest" };

const updating = (provider: ServerProvider) => provider.updateState?.status === "queued" || provider.updateState?.status === "running";

/** engine.list's entries for the models the installed CLI is too old for, after the ones it runs. */
export function modelsNeedingUpdate(provider: ServerProvider | undefined): Array<{ id: string; label: string; efforts: string[]; needs_version: string; description: string }> {
  if (provider === undefined) return [];
  const cli = CLI[provider.driver] ?? provider.displayName ?? provider.driver;
  return (provider.updateRequiredModels ?? [])
    .filter((m) => !provider.models.some((listed) => listed.slug === m.slug))
    .map((m) => ({
      id: m.slug,
      label: m.name,
      efforts: [],
      needs_version: m.minVersion,
      description: updating(provider)
        ? `Needs ${cli} ${m.minVersion}. Caveman Code is updating it now.`
        : `Needs ${cli} ${m.minVersion} or newer (this computer has ${provider.version ?? "an older one"}). Run ${UPDATE_COMMAND[provider.driver] ?? "its update"}.`,
    }));
}

/** "Claude Opus 5.5" → "Claude Opus": models of one family, whatever their version. */
const family = (label: string) => label.replace(/\s*\d+(?:\.\d+)*\s*$/, "");

/**
 * engine.list's models with the ones the CLI is too old for in their place: each just above the newest model of its
 * family the CLI runs (Opus 5.5 above Opus 5, as the catalog lists them, newest first), or first when it runs none
 * of that family. Appended, Opus 5.5 read as the oldest Opus, under Opus 4.5.
 */
export function withModelsNeedingUpdate<M extends { id: string; label: string }>(listed: ReadonlyArray<M>, provider: ServerProvider | undefined): Array<M | ReturnType<typeof modelsNeedingUpdate>[number]> {
  const out: Array<M | ReturnType<typeof modelsNeedingUpdate>[number]> = [...listed];
  // Newest last, each above the first of its family so far: catalog order within a family.
  for (const model of [...modelsNeedingUpdate(provider)].reverse()) {
    const at = out.findIndex((m) => family(m.label) === family(model.label));
    out.splice(at < 0 ? 0 : at, 0, model);
  }
  return out;
}

/** EngineDescriptor.upgrade (Settings > Models & keys): the newest version a listed model needs, and why. */
export function engineUpgrade(provider: ServerProvider | undefined): { version: string; hint: string } | undefined {
  const needed = modelsNeedingUpdate(provider);
  if (provider === undefined || needed.length === 0) return undefined;
  const newest = needed.reduce((a, b) => (compareVersions(b.needs_version, a.needs_version) > 0 ? b : a));
  const cli = CLI[provider.driver] ?? provider.driver;
  const names = needed.map((m) => m.label).join(", ");
  if (updating(provider)) return { version: newest.needs_version, hint: `Updating ${cli} for ${names}` };
  const failed = provider.updateState?.status === "failed" && provider.updateState.message ? ` The update failed: ${provider.updateState.message}` : "";
  return { version: newest.needs_version, hint: `${names} need${needed.length === 1 ? "s" : ""} ${cli} ${newest.needs_version} or newer. Run ${UPDATE_COMMAND[provider.driver] ?? "its update"}.${failed}` };
}

const compareVersions = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/**
 * The installed Claude Code to update now, as `<instance>@<version>` (each is tried once per runtime), or undefined.
 * Only Claude Code: it updates itself by default, so this does what it would do on its next run, and its own
 * opt-out (DISABLE_AUTOUPDATER) holds; the Codex CLI only asks, so it is only listed. Off with Settings'
 * provider update checks, and on a Cloud computer, whose CLIs come with its image.
 */
export function autoUpdateKey(provider: ServerProvider, input: { env: NodeJS.ProcessEnv; updateChecks: boolean; cloudComputer: boolean }): string | undefined {
  if (provider.driver !== "claudeAgent" || !provider.enabled || !provider.installed || !provider.version) return undefined;
  if (!input.updateChecks || input.cloudComputer || input.env.DISABLE_AUTOUPDATER?.trim()) return undefined;
  if (modelsNeedingUpdate(provider).length === 0 || updating(provider)) return undefined;
  return `${provider.instanceId}@${provider.version}`;
}

/** Updates each Claude Code that is too old for a current model, once per installed version, for as long as the runtime runs. */
export const runEngineUpdates = (cloudComputer: boolean) =>
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry;
    const runner = yield* ProviderMaintenanceRunner;
    const settings = yield* ServerSettings.ServerSettingsService;
    const tried = new Set<string>();
    const consider = (providers: ReadonlyArray<ServerProvider>) =>
      Effect.gen(function* () {
        const updateChecks = (yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined)))?.enableProviderUpdateChecks ?? true;
        for (const provider of providers) {
          const key = autoUpdateKey(provider, { env: process.env, updateChecks, cloudComputer });
          if (key === undefined || tried.has(key)) continue;
          tried.add(key);
          const needed = modelsNeedingUpdate(provider).map((m) => `${m.label} (${m.needs_version})`).join(", ");
          yield* Effect.logInfo(`Claude Code ${provider.version} is too old for ${needed}; updating it with its own updater`);
          yield* runner.updateProvider({ provider: provider.driver, instanceId: provider.instanceId }).pipe(
            Effect.flatMap((result) => {
              const after = result.providers.find((p) => p.instanceId === provider.instanceId);
              return Effect.logInfo(`Claude Code update ${after?.updateState?.status ?? "finished"}: ${after?.updateState?.message ?? ""} (now ${after?.version ?? "unknown"})`);
            }),
            Effect.catchCause((cause) => Effect.logWarning("Claude Code update failed", { cause })),
            Effect.forkDetach,
          );
        }
      });
    yield* consider(yield* registry.getProviders);
    yield* Stream.runForEach(registry.streamChanges, consider);
  });
